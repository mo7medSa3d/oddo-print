//go:build windows

package printer

import (
	"errors"
	"syscall"
	"testing"
)

func TestSpoolerAdmissionRefusalClosesHandleWithoutStartingDocument(t *testing.T) {
	var calls spoolerCallLog
	sys := fakeSpoolerSyscalls(&calls, nil)
	closed := 0
	sys.closePrinter = func(syscall.Handle) (uintptr, error) { closed++; return 1, nil }
	started := false
	originalStart := sys.startDocPrinterW
	sys.startDocPrinterW = func(handle syscall.Handle, info *docInfo1) (uintptr, error) {
		started = true
		return originalStart(handle, info)
	}
	refused := errors.New("Gateway refused admission after OpenPrinter")
	result := executeSpoolerSessionWithSyscallsObserved("test", []byte("receipt"), nil, sys, nil, func() error { return refused })
	if !errors.Is(result.err, refused) || started || result.jobID != 0 || result.written != 0 {
		t.Fatalf("refused spooler job started: %+v", result)
	}
	if closed != 1 || calls.endDocCalls != 0 || calls.abortCalls != 0 {
		t.Fatalf("pre-dispatch handle cleanup incorrect: %+v", calls)
	}
}
