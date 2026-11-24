//go:build windows

package printer

import (
	"context"
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procFindFirstPrinterChangeNotification = modWinspool.NewProc("FindFirstPrinterChangeNotification")
	procFindNextPrinterChangeNotification  = modWinspool.NewProc("FindNextPrinterChangeNotification")
	procFindClosePrinterChangeNotification = modWinspool.NewProc("FindClosePrinterChangeNotification")
	procWaitForSingleObject                = modKernel32.NewProc("WaitForSingleObject")
)

const (
	// PRINTER_CHANGE_ALL (winspool.h): every printer, job, driver, port
	// and processor change class. Status changes surface through the JOB
	// and PRINTER classes; subscribing to ALL is the documented way to
	// observe "anything about printing changed" with one handle.
	printerChangeAll = 0x7777FFFF
	// SERVER_ALL_ACCESS (winspool.h): STANDARD_RIGHTS_REQUIRED |
	// SERVER_ACCESS_ADMINISTER | SERVER_ACCESS_ENUMERATE. A change
	// notification on the server handle requires administer access.
	serverAllAccess = 0x000F0003

	waitObject0 = 0x00000000 // WAIT_OBJECT_0
	waitTimeout = 0x00000102 // WAIT_TIMEOUT
	waitFailed  = 0xFFFFFFFF // WAIT_FAILED
)

// printerDefaults mirrors PRINTER_DEFAULTSW for the one field used here.
type printerDefaults struct {
	pDatatype     *uint16
	pDevMode      uintptr
	DesiredAccess uint32
}

// openPrintServerHandle opens a handle to the LOCAL print server. Per the
// OpenPrinter documentation, a NULL printer name opens the local server;
// the fallback passes the explicit \\<computer-name> form.
func openPrintServerHandle() (syscall.Handle, error) {
	defaults := printerDefaults{DesiredAccess: serverAllAccess}
	var hPrinter syscall.Handle
	ret, _, lastErr := procOpenPrinterW.Call(
		0,
		uintptr(unsafe.Pointer(&hPrinter)),
		uintptr(unsafe.Pointer(&defaults)),
	)
	if ret != 0 {
		return hPrinter, nil
	}
	firstErr := lastErr
	if name, nameErr := windows.ComputerName(); nameErr == nil && name != "" {
		namePtr, ptrErr := syscall.UTF16PtrFromString(`\\` + name)
		if ptrErr == nil {
			ret, _, lastErr = procOpenPrinterW.Call(
				uintptr(unsafe.Pointer(namePtr)),
				uintptr(unsafe.Pointer(&hPrinter)),
				uintptr(unsafe.Pointer(&defaults)),
			)
			if ret != 0 {
				return hPrinter, nil
			}
			firstErr = lastErr
		}
	}
	return 0, fmt.Errorf("OpenPrinterW for the local print server failed: %w", firstErr)
}

// WatchSpoolerChanges blocks until ctx is cancelled, invoking onChange
// every time the Windows spooler signals a printer/job change through
// FindFirstPrinterChangeNotification — printer added, removed, renamed,
// paused/resumed, job state changes. It replaces blind periodic rescans
// with the spooler's own event stream; the caller keeps its polling
// fallback for when this returns an error (spooler stopped at start,
// access denied, API failure), and a spooler restart mid-watch surfaces
// as an error so the caller can re-arm on its next start rather than
// spinning here.
func WatchSpoolerChanges(ctx context.Context, onChange func()) error {
	hServer, err := openPrintServerHandle()
	if err != nil {
		return err
	}
	defer procClosePrinter.Call(uintptr(hServer))

	ret, _, lastErr := procFindFirstPrinterChangeNotification.Call(
		uintptr(hServer),
		printerChangeAll,
		0,
		0,
	)
	hChange := syscall.Handle(ret)
	if ret == 0 || hChange == syscall.InvalidHandle {
		return fmt.Errorf("FindFirstPrinterChangeNotification failed: %w", lastErr)
	}
	defer procFindClosePrinterChangeNotification.Call(uintptr(hChange))

	for {
		if ctx.Err() != nil {
			return nil
		}
		// Bounded wait so cancellation is observed within a second even
		// though the notification handle itself has no Go context.
		wret, _, lastErr := procWaitForSingleObject.Call(uintptr(hChange), 1000)
		switch wret {
		case waitObject0:
			// Retrieve + re-arm BEFORE notifying: FindNext both reports
			// what changed and resets the handle for the next signal, so
			// a change arriving during the caller's rescan is not lost.
			var changed uint32
			nret, _, nerr := procFindNextPrinterChangeNotification.Call(
				uintptr(hChange),
				uintptr(unsafe.Pointer(&changed)),
				0,
				0,
			)
			if nret == 0 {
				return fmt.Errorf("FindNextPrinterChangeNotification failed: %w", nerr)
			}
			if onChange != nil {
				onChange()
			}
		case waitTimeout:
			continue
		default:
			return fmt.Errorf("WaitForSingleObject on printer change handle failed (0x%x): %w", wret, lastErr)
		}
	}
}
