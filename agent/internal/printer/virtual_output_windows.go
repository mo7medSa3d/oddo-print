//go:build windows

package printer

import (
	"log"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// resolveVirtualOutputPathForHandle inspects an already-open Windows printer
// handle and returns a concrete output file path when the queue uses an
// interactive file-prompt port (PORTPROMPT:, FILE:, XPSPORT:). For physical
// queues or fixed ports (or if GetPrinterW is unavailable in mock tests), it
// returns "" so pOutputFile stays nil.
func resolveVirtualOutputPathForHandle(hPrinter syscall.Handle, spoolerName, jobID string) string {
	if hPrinter == 0 {
		return ""
	}
	pi, keepBuf, err := getPrinterInfo2(hPrinter)
	if err != nil || pi == nil {
		return ""
	}
	defer runtime.KeepAlive(keepBuf)
	portName := utf16PtrToString(pi.pPortName)
	driverName := utf16PtrToString(pi.pDriverName)
	outPath := buildVirtualOutputPath(defaultVirtualOutputDir(), portName, driverName, spoolerName, jobID, time.Now().UTC())
	if outPath == "" {
		return ""
	}
	if !filepath.IsAbs(outPath) {
		if absPath, absErr := filepath.Abs(outPath); absErr == nil {
			outPath = absPath
		}
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		log.Printf("virtual printer %q: failed to create output directory %q: %v", spoolerName, filepath.Dir(outPath), err)
		return ""
	}
	log.Printf("virtual printer %q (port=%s): routing Session 0 output to %s", spoolerName, portName, outPath)
	return outPath
}

// resolveVirtualOutputPath opens the named Windows spooler queue briefly to
// determine whether it targets a prompting virtual port (PORTPROMPT:, FILE:,
// XPSPORT:) and, if so, allocates a silent output file path for GDI StartDocW.
func resolveVirtualOutputPath(spoolerName, jobID string) string {
	if spoolerName == "" {
		return ""
	}
	namePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return ""
	}
	defer runtime.KeepAlive(namePtr)
	var hPrinter syscall.Handle
	ret, _ := defaultSpoolerSyscalls().openPrinterW(namePtr, &hPrinter)
	if ret == 0 || hPrinter == 0 {
		return ""
	}
	defer defaultSpoolerSyscalls().closePrinter(hPrinter)
	return resolveVirtualOutputPathForHandle(hPrinter, spoolerName, jobID)
}
