//go:build windows

package printer

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

var virtualOutputSeq atomic.Uint64

// resolveVirtualOutputPathForHandle inspects an already-open Windows printer
// handle and returns a concrete output file path when the queue uses an
// interactive file-prompt port (PORTPROMPT:, FILE:, XPSPORT:). For physical
// queues or fixed ports (or if GetPrinterW is unavailable in mock tests), it
// returns "", nil so pOutputFile stays nil. If the port is prompting and the
// output directory cannot be created, it returns an error so Session 0 fails
// fast instead of hanging on an invisible "Save Print Output As..." dialog.
func resolveVirtualOutputPathForHandle(hPrinter syscall.Handle, spoolerName, jobID string) (string, error) {
	if hPrinter == 0 {
		return "", nil
	}
	pi, keepBuf, err := getPrinterInfo2(hPrinter)
	if err != nil || pi == nil {
		return "", nil
	}
	defer runtime.KeepAlive(keepBuf)
	portName := utf16PtrToString(pi.pPortName)
	driverName := utf16PtrToString(pi.pDriverName)
	// Windows system clock resolution (~0.5–15.6ms) can repeat across rapid
	// back-to-back jobs; append a monotonic sequence so filenames never collide.
	seq := strconv.FormatUint(virtualOutputSeq.Add(1), 10)
	uniqueJobID := "seq-" + seq
	if jobID != "" {
		uniqueJobID = jobID + "-" + seq
	}
	outPath := buildVirtualOutputPath(defaultVirtualOutputDir(), portName, driverName, spoolerName, uniqueJobID, time.Now().UTC())
	if outPath == "" {
		return "", nil
	}
	if !filepath.IsAbs(outPath) {
		if absPath, absErr := filepath.Abs(outPath); absErr == nil {
			outPath = absPath
		}
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0750); err != nil {
		return "", fmt.Errorf("virtual printer %q: create output directory %q: %w", spoolerName, filepath.Dir(outPath), err)
	}
	log.Printf("virtual printer %q (port=%s): routing Session 0 output to %s", spoolerName, portName, outPath)
	return outPath, nil
}

// resolveVirtualOutputPath opens the named Windows spooler queue briefly to
// determine whether it targets a prompting virtual port (PORTPROMPT:, FILE:,
// XPSPORT:) and, if so, allocates a silent output file path for GDI StartDocW.
func resolveVirtualOutputPath(spoolerName, jobID string) (string, error) {
	if spoolerName == "" {
		return "", nil
	}
	namePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return "", nil
	}
	defer runtime.KeepAlive(namePtr)
	var hPrinter syscall.Handle
	ret, _ := defaultSpoolerSyscalls().openPrinterW(namePtr, &hPrinter)
	if ret == 0 || hPrinter == 0 {
		return "", nil
	}
	defer defaultSpoolerSyscalls().closePrinter(hPrinter)
	return resolveVirtualOutputPathForHandle(hPrinter, spoolerName, jobID)
}
