//go:build windows

package printer

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procDocumentPropertiesW = modWinspool.NewProc("DocumentPropertiesW")
var procResetDCW = modGDI32.NewProc("ResetDCW")

func pdfPrinterDevMode(printerName string, paper pdfPaper) ([]byte, error) {
	return readPDFPrinterDevMode(printerName, &paper)
}

func pdfPrinterCurrentDevMode(printerName string) ([]byte, error) {
	return readPDFPrinterDevMode(printerName, nil)
}

func readPDFPrinterDevMode(printerName string, paper *pdfPaper) ([]byte, error) {
	name, err := windows.UTF16PtrFromString(printerName)
	if err != nil {
		return nil, err
	}
	handle, err := openPrinterWPtr(name)
	if err != nil {
		return nil, err
	}
	defer procClosePrinter.Call(uintptr(handle))
	size, _, callErr := procDocumentPropertiesW.Call(0, uintptr(handle), uintptr(unsafe.Pointer(name)), 0, 0, 0)
	if int32(size) < 92 || size > 1<<20 {
		return nil, fmt.Errorf("DocumentPropertiesW returned invalid size %d: %v", int32(size), callErr)
	}
	buf := make([]byte, int(size))
	// Keep pointer conversions in the syscall argument list so the compiler
	// retains the allocation for the complete native call.
	ret, _, callErr := procDocumentPropertiesW.Call(0, uintptr(handle), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&buf[0])), 0, 2) // DM_OUT_BUFFER
	if int32(ret) != 1 {
		return nil, fmt.Errorf("read printer DEVMODEW: %v", callErr)
	}
	if paper == nil {
		err = configurePDFCurrentMedia(buf)
	} else {
		err = configurePDFDevMode(buf, *paper)
	}
	if err != nil {
		return nil, err
	}
	ret, _, callErr = procDocumentPropertiesW.Call(0, uintptr(handle), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&buf[0])), 2|8) // OUT|IN_BUFFER
	if int32(ret) != 1 {
		return nil, fmt.Errorf("driver rejected PDF paper settings: %v", callErr)
	}
	if err := validatePDFDevModeResult(buf); err != nil {
		return nil, fmt.Errorf("driver changed requested PDF settings: %w", err)
	}
	return buf, nil
}

func resetPDFPrinterDC(hdc uintptr, mode []byte) (uintptr, error) {
	if len(mode) == 0 {
		return 0, fmt.Errorf("missing validated printer DEVMODEW")
	}
	ret, _, callErr := procResetDCW.Call(hdc, uintptr(unsafe.Pointer(&mode[0])))
	if ret == 0 {
		return 0, fmt.Errorf("ResetDCW for PDF page failed: %v", callErr)
	}
	return ret, nil
}
