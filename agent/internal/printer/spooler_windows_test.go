//go:build windows

package printer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// The preflight check runs synchronously against Win32 spooler RPC, which has
// no deadline of its own. These tests prove the caller-side bound of
// runPreflightBounded using injected checks (no real spooler involved).
func TestPreflightBoundedSlowCheckPassesThrough(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	err := runPreflightBounded("slow-ok", 2*time.Second, ctx, func() error {
		time.Sleep(50 * time.Millisecond)
		return nil
	})
	if err != nil {
		t.Fatalf("slow-but-healthy check must pass through, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("healthy check took too long: %v", time.Since(start))
	}
}

func TestPreflightBoundedStuckCheckTimesOutFailClosed(t *testing.T) {
	block := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	err := runPreflightBounded("wedged-spooler", 150*time.Millisecond, ctx, func() error {
		<-block // simulates OpenPrinterW wedged on a dead spooler RPC
		return nil
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("stuck readiness check must fail, not hang")
	}
	if !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("timeout must stay a typed not-ready failure, got %v", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("caller was not bounded: waited %v", elapsed)
	}
	// A timeout is provably pre-dispatch (status queries spool nothing), so
	// it must NOT carry an unknown-outcome marker.
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("preflight timeout must not be classified unknown: %v", err)
	}
	close(block)
}

func TestPreflightBoundedCancelledContextReturnsFast(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	block := make(chan struct{})
	defer close(block)
	start := time.Now()
	err := runPreflightBounded("cancelled", 5*time.Second, ctx, func() error {
		<-block
		return nil
	})
	if err == nil {
		t.Fatal("cancelled preflight must fail")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("cancelled caller was not bounded: waited %v", time.Since(start))
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-dispatch cancellation must not be classified unknown: %v", err)
	}
}

func TestPreflightBoundedPropagatesCheckFailure(t *testing.T) {
	want := errors.New("boom")
	err := runPreflightBounded("failing", time.Second, context.Background(), func() error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("check failure must pass through unchanged, got %v", err)
	}
}

func TestBoundedPreflightSingleFlightRefusesOverlap(t *testing.T) {
	p := &SpoolerPrinter{Name: "T", SpoolerName: "wedged_spooler_singleflight"}
	block := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- p.boundedPreflight(context.Background(), 300*time.Millisecond, func() error {
			<-block // wedged RPC: never returns until released
			return nil
		})
	}()
	// Let the first call register its in-flight helper.
	time.Sleep(50 * time.Millisecond)

	// A second overlapping call must fail FAST, not spawn another helper
	// that would accumulate behind the wedged RPC.
	start := time.Now()
	err := p.boundedPreflight(context.Background(), 5*time.Second, func() error { return nil })
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("overlapping preflight must be refused while one is stuck")
	}
	if !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("refusal must stay a typed not-ready failure, got %v", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("refusal was not fast: waited %v", elapsed)
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-dispatch refusal must not be classified unknown: %v", err)
	}

	// Once the wedged RPC finally returns, the flag clears and the next
	// call proceeds normally: recovery is automatic, no restart required.
	// (The helper holds the flag until ITS check returns, not until the
	// bounded caller gives up - otherwise every timeout would leak one more
	// stuck helper behind the wedged RPC.)
	close(block)
	<-done
	err = p.boundedPreflight(context.Background(), 2*time.Second, func() error { return nil })
	if err != nil {
		t.Fatalf("recovered spooler must accept preflight again, got %v", err)
	}
}

func TestSpoolerSessionWaitHonorsContext(t *testing.T) {
	p := &SpoolerPrinter{Name: "T", SpoolerName: "session_mutex_test"}
	p.sessionMu.Lock()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := p.waitBeginSession(ctx)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("waitBeginSession must refuse a blocked session")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked session must honor context cancellation, got %v", err)
	}
	if elapsed > time.Second {
		t.Fatalf("blocked session waited too long: %v", elapsed)
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-dispatch session refusal must not be classified unknown: %v", err)
	}

	p.sessionMu.Unlock()
	if err := p.waitBeginSession(context.Background()); err != nil {
		t.Fatalf("session slot must be reusable after release, got %v", err)
	}
	p.endSession()
}

func TestSpoolerStatusUnknownPrinterIsUnknown(t *testing.T) {
	// No such queue exists on any Windows host, so OpenPrinterW reliably
	// fails. That proves queue inaccessibility in this security context, not
	// physical device reachability, so the truthful wire state is unknown.
	p := &SpoolerPrinter{
		Name:        "T",
		SpoolerName: "definitely-not-a-real-printer-4f2a9c",
		Timeout:     10 * time.Second,
	}
	if st := p.Status(); st != "unknown" {
		t.Fatalf("unknown/inaccessible spooler queue must report unknown, got %q", st)
	}
}

func TestSpoolerWritePartialBytesThenErrorIsUnknown(t *testing.T) {
	mockSyscalls := defaultSpoolerSyscalls
	mockSyscalls.openPrinterW = func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error) {
		*hPrinter = 321
		return 1, nil
	}
	mockSyscalls.closePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.startDocPrinterW = func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error) { return 456, nil }
	mockSyscalls.startPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.writePrinter = func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = 3
		return 0, syscall.Errno(31)
	}
	mockSyscalls.endPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	// The real AbortPrinter would be called with a fake handle here; the
	// session cleanup path must be faked like every other syscall.
	mockSyscalls.abortPrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }

	res := executeSpoolerSessionWithSyscalls("PartialErrorPrinter", []byte("receipt payload"), nil, mockSyscalls)
	if res.err == nil {
		t.Fatal("partial WritePrinter bytes with failure must not report success")
	}
	if !OutcomeUnknown(res.err) {
		t.Fatalf("partial WritePrinter bytes with failure must be classified unknown: %v", res.err)
	}
	if res.written != 3 {
		t.Fatalf("partial bytes must be preserved as evidence, got %d", res.written)
	}
}

func TestSpoolerWriteOverReportCannotSucceed(t *testing.T) {
	mockSyscalls := defaultSpoolerSyscalls
	mockSyscalls.openPrinterW = func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error) {
		*hPrinter = 322
		return 1, nil
	}
	mockSyscalls.closePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.startDocPrinterW = func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error) { return 457, nil }
	mockSyscalls.startPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.writePrinter = func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		// Faulty driver: reports success with more bytes than submitted.
		*bytesWritten = uint32(length) + 10
		return 1, nil
	}
	mockSyscalls.endPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	endDocCalled := false
	mockSyscalls.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		endDocCalled = true
		return 1, nil
	}
	abortCalled := false
	mockSyscalls.abortPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		abortCalled = true
		return 1, nil
	}

	data := []byte("receipt payload")
	res := executeSpoolerSessionWithSyscalls("OverReportPrinter", data, nil, mockSyscalls)
	if res.err == nil {
		t.Fatal("driver over-report must not finalize as a successful print")
	}
	if !OutcomeUnknown(res.err) {
		t.Fatalf("driver over-report must be classified unknown: %v", res.err)
	}
	if endDocCalled {
		t.Fatal("a truncated document with uncertain wire state must never reach EndDocPrinter")
	}
	if !abortCalled {
		t.Fatal("an uncertain document session must be aborted so truncated output is discarded")
	}
	if res.written != 0 {
		t.Fatalf("over-report evidence must stay at honestly confirmed bytes, got %d", res.written)
	}
}

func TestSpoolerFailedWriteWithOverReportedCountStillAborts(t *testing.T) {
	mockSyscalls := defaultSpoolerSyscalls
	mockSyscalls.openPrinterW = func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error) {
		*hPrinter = 323
		return 1, nil
	}
	mockSyscalls.closePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.startDocPrinterW = func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error) { return 458, nil }
	mockSyscalls.startPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	mockSyscalls.writePrinter = func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		// Faulty driver: fails while claiming more bytes than remain.
		// The evidence counter caps at the payload size, which must not
		// read as completion evidence for the session cleanup.
		*bytesWritten = uint32(length) + 100000
		return 0, syscall.Errno(31)
	}
	mockSyscalls.endPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	endDocCalled := false
	mockSyscalls.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		endDocCalled = true
		return 1, nil
	}
	abortCalled := false
	mockSyscalls.abortPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		abortCalled = true
		return 1, nil
	}

	data := []byte("receipt payload")
	res := executeSpoolerSessionWithSyscalls("FailedOverReportPrinter", data, nil, mockSyscalls)
	if res.err == nil {
		t.Fatal("failed WritePrinter must not report success")
	}
	if !OutcomeUnknown(res.err) {
		t.Fatalf("failed WritePrinter with bytes folded in must stay unknown: %v", res.err)
	}
	if endDocCalled {
		t.Fatal("a capped byte counter must never finalize the document via EndDocPrinter")
	}
	if !abortCalled {
		t.Fatal("a failed document session must be aborted")
	}
}

func TestSpoolerEndPagePrinterFailureCannotSucceed(t *testing.T) {
	mockSyscalls := defaultSpoolerSyscalls
	mockSyscalls.openPrinterW = func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error) {
		*hPrinter = 123
		return 1, nil
	}
	mockSyscalls.closePrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		return 1, nil
	}
	mockSyscalls.startDocPrinterW = func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error) {
		return 456, nil
	}
	mockSyscalls.startPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		return 1, nil
	}
	mockSyscalls.writePrinter = func(hPrinter syscall.Handle, buf unsafe.Pointer, len int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = uint32(len)
		return 1, nil
	}
	mockSyscalls.endPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		// Simulate EndPagePrinter failure
		return 0, syscall.Errno(6) // ERROR_INVALID_HANDLE
	}
	mockSyscalls.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		return 1, nil
	}
	mockSyscalls.abortPrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }

	data := []byte("receipt line 1\nreceipt line 2\n")
	res := executeSpoolerSessionWithSyscalls("TestPrinter", data, nil, mockSyscalls)
	if res.err == nil {
		t.Fatal("EndPagePrinter failure must NOT result in a successful print")
	}
	if !OutcomeUnknown(res.err) {
		t.Fatalf("EndPagePrinter failure must be classified as unknown outcome, got %v", res.err)
	}
	if !strings.Contains(res.err.Error(), "EndPagePrinter failed") {
		t.Fatalf("error must identify EndPagePrinter failure, got %v", res.err)
	}

	// Verify that when EndPagePrinter succeeds, the session reports success.
	mockSyscalls.endPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		return 1, nil
	}
	resSuccess := executeSpoolerSessionWithSyscalls("TestPrinter", data, nil, mockSyscalls)
	if resSuccess.err != nil {
		t.Fatalf("expected successful print when EndPagePrinter succeeds, got %v", resSuccess.err)
	}
	if resSuccess.written != uint32(len(data)) {
		t.Fatalf("expected %d bytes written, got %d", len(data), resSuccess.written)
	}
}

// spoolerCallLog counts how a document session was closed.
type spoolerCallLog struct {
	abortCalls  int
	endDocCalls int
}

// fakeSpoolerSyscalls builds a Win32 spooler fake. No print queue, driver or
// spooler service is involved: every syscall in the document session is
// replaced, so the session logic (finalize vs discard) is provable on any
// Windows machine, including a build agent with no printers at all.
func fakeSpoolerSyscalls(log *spoolerCallLog, write func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error)) spoolerSyscalls {
	sys := defaultSpoolerSyscalls
	sys.openPrinterW = func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error) {
		*hPrinter = 4711
		return 1, nil
	}
	sys.closePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	sys.startDocPrinterW = func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error) { return 7, nil }
	sys.startPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	sys.endPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) { return 1, nil }
	sys.writePrinter = write
	sys.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		log.endDocCalls++
		return 1, nil
	}
	sys.abortPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		log.abortCalls++
		return 1, nil
	}
	return sys
}

// A complete document must be RELEASED with EndDocPrinter, never discarded.
func TestSpoolerCompleteDocumentIsFinalizedNotAborted(t *testing.T) {
	var log spoolerCallLog
	payload := []byte("receipt payload")
	sys := fakeSpoolerSyscalls(&log, func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = uint32(length)
		return 1, nil
	})

	res := executeSpoolerSessionWithSyscalls("CompletePrinter", payload, nil, sys)
	if res.err != nil {
		t.Fatalf("complete document must print cleanly, got %v", res.err)
	}
	if res.written != uint32(len(payload)) {
		t.Fatalf("expected %d bytes written, got %d", len(payload), res.written)
	}
	if log.endDocCalls != 1 || log.abortCalls != 0 {
		t.Fatalf("complete document must be finalized exactly once (endDoc=%d abort=%d)", log.endDocCalls, log.abortCalls)
	}
}

// Win32 reports success through the BOOL return value; GetLastError is only
// meaningful after a zero return. A stale non-zero error on a SUCCESSFUL
// EndDocPrinter must not turn a real print into an ambiguous failure.
func TestSpoolerEndDocPrinterStaleLastErrorIsNotAFailure(t *testing.T) {
	var log spoolerCallLog
	payload := []byte("receipt payload")
	sys := fakeSpoolerSyscalls(&log, func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = uint32(length)
		return 1, nil
	})
	sys.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		log.endDocCalls++
		return 1, syscall.Errno(5) // BOOL success, stale ERROR_ACCESS_DENIED
	}

	res := executeSpoolerSessionWithSyscalls("StaleErrorPrinter", payload, nil, sys)
	if res.err != nil {
		t.Fatalf("a successful EndDocPrinter with a stale last error must not fail: %v", res.err)
	}
	if log.abortCalls != 0 {
		t.Fatalf("a successful document must never be aborted, abort=%d", log.abortCalls)
	}
}

// A failed EndDocPrinter is a real failure: the spooler may discard the job,
// so it must be reported as unknown rather than as printed.
func TestSpoolerEndDocPrinterFailureIsUnknown(t *testing.T) {
	var log spoolerCallLog
	payload := []byte("receipt payload")
	sys := fakeSpoolerSyscalls(&log, func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = uint32(length)
		return 1, nil
	})
	sys.endDocPrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		log.endDocCalls++
		return 0, syscall.Errno(6) // ERROR_INVALID_HANDLE
	}

	res := executeSpoolerSessionWithSyscalls("EndDocFailPrinter", payload, nil, sys)
	if res.err == nil || !OutcomeUnknown(res.err) {
		t.Fatalf("failed EndDocPrinter must be an unknown outcome, got %v", res.err)
	}
	if log.endDocCalls != 1 {
		t.Fatalf("EndDocPrinter must not be retried by the cleanup path, calls=%d", log.endDocCalls)
	}
}

// A truncated document must be DISCARDED with AbortPrinter. Finalizing it
// would release a half-written receipt to the printer.
func TestSpoolerPartialWriteIsAbortedNotFinalized(t *testing.T) {
	var log spoolerCallLog
	sys := fakeSpoolerSyscalls(&log, func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = 3
		return 0, syscall.Errno(31) // ERROR_GEN_FAILURE
	})

	res := executeSpoolerSessionWithSyscalls("PartialPrinter", []byte("receipt payload"), nil, sys)
	if res.err == nil || !OutcomeUnknown(res.err) {
		t.Fatalf("partial write must be an unknown outcome, got %v", res.err)
	}
	if res.written != 3 {
		t.Fatalf("partial bytes must be preserved as evidence, got %d", res.written)
	}
	if log.abortCalls != 1 || log.endDocCalls != 0 {
		t.Fatalf("truncated document must be aborted once and never finalized (abort=%d endDoc=%d)", log.abortCalls, log.endDocCalls)
	}
}

// Cancellation has two very different meanings and the session must tell them
// apart: before StartDocPrinter nothing was ever submitted (so there is no
// spool file to discard), and after StartDocPrinter the job exists and must be
// aborted so a partial document is never released.
func TestSpoolerCancellationDiscardsOnlyStartedDocuments(t *testing.T) {
	var log spoolerCallLog
	sys := fakeSpoolerSyscalls(&log, func(hPrinter syscall.Handle, buf unsafe.Pointer, length int, bytesWritten *uint32) (uintptr, error) {
		*bytesWritten = uint32(length)
		return 1, nil
	})

	// Case 1 — cancelled before the document starts: no job was created, so
	// neither AbortPrinter nor EndDocPrinter may be issued.
	preCancel := make(chan struct{})
	close(preCancel)
	pre := executeSpoolerSessionWithSyscalls("PreDocCancelPrinter", []byte("receipt payload"), preCancel, sys)
	if pre.err == nil {
		t.Fatal("a pre-document cancellation must fail")
	}
	if OutcomeUnknown(pre.err) {
		t.Fatalf("a pre-document cancellation cannot be an unknown outcome: %v", pre.err)
	}
	if log.abortCalls != 0 || log.endDocCalls != 0 {
		t.Fatalf("a document that never started must not be closed (abort=%d endDoc=%d)", log.abortCalls, log.endDocCalls)
	}

	// Case 2 — cancelled after StartDocPrinter but before any byte is written:
	// the job exists and must be discarded, never finalized.
	cancel := make(chan struct{})
	sys.startPagePrinter = func(hPrinter syscall.Handle) (uintptr, error) {
		close(cancel)
		return 1, nil
	}
	res := executeSpoolerSessionWithSyscalls("CancelledPrinter", []byte("receipt payload"), cancel, sys)
	if res.err == nil {
		t.Fatal("cancelled session must fail")
	}
	if OutcomeUnknown(res.err) {
		t.Fatalf("cancellation before any byte was written must not be unknown: %v", res.err)
	}
	if log.abortCalls != 1 || log.endDocCalls != 0 {
		t.Fatalf("a cancelled document must be aborted and never finalized (abort=%d endDoc=%d)", log.abortCalls, log.endDocCalls)
	}
}

// fakePrinterInfo2 returns a fake PRINTER_INFO_2 query with the given status
// and attribute bits, so queue-state logic is testable without a queue.
func fakePrinterInfo2(status, attributes uint32) func(syscall.Handle) (*printerInfo2, []byte, error) {
	return func(hPrinter syscall.Handle) (*printerInfo2, []byte, error) {
		buf := make([]byte, unsafe.Sizeof(printerInfo2{}))
		pi := (*printerInfo2)(unsafe.Pointer(&buf[0]))
		pi.Status = status
		pi.Attributes = attributes
		return pi, buf, nil
	}
}

// withFakeQueue swaps the Win32 open/query calls for fakes for one test and
// restores them through setPrinterHooks, so a probe goroutine that outlived
// its caller can never observe a torn hook write.
func withFakeQueue(t *testing.T, status, attributes uint32) {
	t.Helper()
	restore := setPrinterHooks(
		func(printerNamePtr *uint16) (syscall.Handle, error) { return 4711, nil },
		fakePrinterInfo2(status, attributes),
	)
	t.Cleanup(restore)
}

func TestPreFlightAcceptsHealthyQueue(t *testing.T) {
	withFakeQueue(t, 0, 0)
	if err := preFlightSpoolerCheck("Healthy Printer"); err != nil {
		t.Fatalf("healthy queue must pass the pre-flight check, got %v", err)
	}
}

func TestPreFlightRejectsOfflineQueue(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_OFFLINE, 0)
	err := preFlightSpoolerCheck("Offline Printer")
	if !errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("offline queue must report ErrPrinterOffline, got %v", err)
	}
}

func TestPreFlightRejectsWorkOfflineQueue(t *testing.T) {
	withFakeQueue(t, 0, PRINTER_ATTRIBUTE_WORK_OFFLINE)
	err := preFlightSpoolerCheck("Work Offline Printer")
	if !errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("WorkOffline queue must report ErrPrinterOffline, got %v", err)
	}
}

func TestHeartbeatStatusPreservesWindowsActivityBits(t *testing.T) {
	for _, tc := range []struct {
		name string
		bit  uint32
	}{
		{"io-active", PRINTER_STATUS_IO_ACTIVE},
		{"busy", PRINTER_STATUS_BUSY},
		{"printing", PRINTER_STATUS_PRINTING},
		{"processing", PRINTER_STATUS_PROCESSING},
		{"initializing", PRINTER_STATUS_INITIALIZING},
		{"warming-up", PRINTER_STATUS_WARMING_UP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withFakeQueue(t, tc.bit, 0)
			p := &SpoolerPrinter{Name: "T", SpoolerName: "Activity Printer", Timeout: time.Second}
			if got := p.Status(); got != "busy" {
				t.Fatalf("heartbeat status=%q want busy for bit 0x%08x", got, tc.bit)
			}
			if err := dispatchPreFlightSpoolerCheck("Activity Printer"); err != nil {
				t.Fatalf("activity-only status must not block dispatch: %v", err)
			}
		})
	}
}

func TestPreFlightServerUnknownIsInconclusiveNotOffline(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_SERVER_UNKNOWN, 0)
	err := preFlightSpoolerCheck("Server Unknown Printer")
	if err == nil {
		t.Fatal("status probe must preserve SERVER_UNKNOWN evidence")
	}
	if !errors.Is(err, ErrSpoolerStatusUnknown) {
		t.Fatalf("SERVER_UNKNOWN must preserve unknown status evidence, got %v", err)
	}
	if errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("SERVER_UNKNOWN is not proof of offline, got %v", err)
	}
	if err := dispatchPreFlightSpoolerCheck("Server Unknown Printer"); err != nil {
		t.Fatalf("SERVER_UNKNOWN alone must not block spool submission, got %v", err)
	}

	p := &SpoolerPrinter{Name: "T", SpoolerName: "Server Unknown Printer", Timeout: time.Second}
	if st := p.Status(); st != "unknown" {
		t.Fatalf("SERVER_UNKNOWN heartbeat status must remain unknown, got %q", st)
	}
}

func TestPreFlightExplicitBlockingStatusOutranksServerUnknown(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_SERVER_UNKNOWN|PRINTER_STATUS_PAUSED, 0)
	err := preFlightSpoolerCheck("Paused Unknown Printer")
	if err == nil || !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("explicit paused status must fail closed, got %v", err)
	}
	if errors.Is(err, ErrSpoolerStatusUnknown) {
		t.Fatalf("SERVER_UNKNOWN must not hide a concrete paused state: %v", err)
	}
	if errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("paused plus SERVER_UNKNOWN is not proof of physical offline: %v", err)
	}
	if dispatchErr := dispatchPreFlightSpoolerCheck("Paused Unknown Printer"); dispatchErr == nil || !errors.Is(dispatchErr, ErrPrinterNotReady) {
		t.Fatalf("dispatch allowance for SERVER_UNKNOWN must not bypass PAUSED, got %v", dispatchErr)
	}
}

func TestPreFlightRejectsPendingDeletion(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_PENDING_DELETION, 0)
	err := preFlightSpoolerCheck("Deleting Printer")
	if err == nil || !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("pending-deletion queue must be non-routable before dispatch, got %v", err)
	}
	if errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("pending deletion is an administrative queue state, not physical offline: %v", err)
	}
}

func TestPreFlightRejectsDocumentedBlockingStatuses(t *testing.T) {
	cases := []struct {
		name   string
		status uint32
	}{
		{name: "paused", status: PRINTER_STATUS_PAUSED},
		{name: "paper problem", status: PRINTER_STATUS_PAPER_PROBLEM},
		{name: "manual feed", status: PRINTER_STATUS_MANUAL_FEED},
		{name: "output bin full", status: PRINTER_STATUS_OUTPUT_BIN_FULL},
		{name: "no toner", status: PRINTER_STATUS_NO_TONER},
		{name: "page punt", status: PRINTER_STATUS_PAGE_PUNT},
		{name: "out of memory", status: PRINTER_STATUS_OUT_OF_MEMORY},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withFakeQueue(t, tc.status, 0)
			err := preFlightSpoolerCheck("Blocked Printer")
			if err == nil || !errors.Is(err, ErrPrinterNotReady) {
				t.Fatalf("status 0x%08x must fail closed, got %v", tc.status, err)
			}
			if errors.Is(err, ErrPrinterOffline) {
				t.Fatalf("status 0x%08x is a readiness/error state, not offline: %v", tc.status, err)
			}
		})
	}
}

func TestPreFlightRejectsPaperOutAndIsNotOffline(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_PAPER_OUT, 0)
	err := preFlightSpoolerCheck("Paper Out Printer")
	if err == nil {
		t.Fatal("paper-out queue must be refused before dispatch")
	}
	if errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("paper out is not an offline condition, got %v", err)
	}
}

// A queue whose status cannot be read must fail closed, never report ready.
func TestPreFlightFailsClosedWhenStatusUnreadable(t *testing.T) {
	restore := setPrinterHooks(
		func(printerNamePtr *uint16) (syscall.Handle, error) { return 4711, nil },
		func(hPrinter syscall.Handle) (*printerInfo2, []byte, error) {
			return nil, nil, fmt.Errorf("simulated GetPrinterW failure")
		},
	)
	defer restore()
	if err := preFlightSpoolerCheck("Unreadable Printer"); err == nil {
		t.Fatal("an unreadable queue must not be reported as ready")
	}
}

// Status() must never fabricate "online" for a queue it could not read, and
// must never spawn a second stuck helper while one is already wedged in
// Win32 (the single-flight guard is what prevents that leak).
func TestSpoolerStatusUnreadableQueueIsNotOnline(t *testing.T) {
	p := &SpoolerPrinter{Name: "T", SpoolerName: "unreadable_queue", Timeout: time.Second}
	withFakeQueue(t, PRINTER_STATUS_OFFLINE, 0)
	if st := p.Status(); st != "offline" {
		t.Fatalf("offline queue must report offline, got %q", st)
	}

	// A probe that never returns must surface as unknown (bounded), and a
	// second call must be refused immediately instead of leaking another
	// blocked goroutine. The wedged probe is released and JOINED before the
	// hooks are restored: restoring while the abandoned helper is still
	// reading them is exactly the race this test used to provoke.
	release := make(chan struct{})
	restore := setPrinterHooks(
		func(printerNamePtr *uint16) (syscall.Handle, error) {
			<-release
			return 4711, nil
		},
		fakePrinterInfo2(0, 0),
	)
	start := time.Now()
	st := p.Status()
	if st != "unknown" {
		t.Fatalf("a probe that never completes must report unknown, got %q", st)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("status probe was not bounded: %v", elapsed)
	}
	if st2 := p.Status(); st2 != "unknown" {
		t.Fatalf("overlapping probe must be refused as unknown, got %q", st2)
	}

	// Let the abandoned helper finish, then restore. preflightActive clears
	// only after the probe function returns, so polling it joins the helper
	// without touching any hook.
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for p.preflightActive.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.preflightActive.Load() {
		t.Fatal("wedged probe never released its single-flight slot after the RPC returned")
	}
	restore()
}

// A StartDocPrinterW identity is evidence for the current attempt, not a
// success signal. It must survive later failure/uncertainty, while an attempt
// that never allocated a job must clear a stale prior identity.
func TestPrintRecordsSpoolerJobIDOnSuccess(t *testing.T) {
	withFakeQueue(t, 0, 0)
	prev := currentExecuteSpoolerSession
	currentExecuteSpoolerSession = func(spoolerName string, data []byte, cancelNotice <-chan struct{}, onJobID func(uintptr), admit ...func() error) spoolerTaskResult {
		if onJobID != nil {
			onJobID(456)
		}
		return spoolerTaskResult{jobID: 456, written: 16}
	}
	t.Cleanup(func() { currentExecuteSpoolerSession = prev })
	p := NewSpooler("EvidencePrinter", "")
	if err := p.Print(context.Background(), []byte("evidence payload")); err != nil {
		t.Fatalf("fake session must succeed, got %v", err)
	}
	if got := p.LastSpoolerJobID(); got != "456" {
		t.Fatalf("successful session must record spooler job ID 456, got %q", got)
	}
	if got := SpoolerJobIDOf(p); got != "456" {
		t.Fatalf("SpoolerJobIDOf must surface the recorded ID, got %q", got)
	}
}

func TestPrintLeavesNoSpoolerJobIDOnFailure(t *testing.T) {
	withFakeQueue(t, 0, 0)
	prev := currentExecuteSpoolerSession
	currentExecuteSpoolerSession = func(spoolerName string, data []byte, cancelNotice <-chan struct{}, onJobID func(uintptr), admit ...func() error) spoolerTaskResult {
		return spoolerTaskResult{err: errors.New("simulated session failure")}
	}
	t.Cleanup(func() { currentExecuteSpoolerSession = prev })
	p := NewSpooler("EvidencePrinter", "")
	if err := p.Print(context.Background(), []byte("evidence payload")); err == nil {
		t.Fatal("fake session must fail")
	}
	if got := p.LastSpoolerJobID(); got != "" {
		t.Fatalf("failed session must record no spooler job ID, got %q", got)
	}
}

func TestPrintPreservesAllocatedSpoolerJobIDOnFailure(t *testing.T) {
	withFakeQueue(t, 0, 0)
	prev := currentExecuteSpoolerSession
	currentExecuteSpoolerSession = func(spoolerName string, data []byte, cancelNotice <-chan struct{}, onJobID func(uintptr), admit ...func() error) spoolerTaskResult {
		if onJobID != nil {
			onJobID(654)
		}
		return spoolerTaskResult{jobID: 654, err: MarkUnknown("simulated failure after StartDocPrinterW")}
	}
	t.Cleanup(func() { currentExecuteSpoolerSession = prev })
	p := NewSpooler("EvidencePrinter", "")
	if err := p.Print(context.Background(), []byte("evidence payload")); err == nil {
		t.Fatal("fake session must fail")
	}
	if got := p.LastSpoolerJobID(); got != "654" {
		t.Fatalf("failed attempt must preserve allocated spooler job ID 654, got %q", got)
	}
}

func TestPDFPrintRecordsCurrentGDISpoolerJobID(t *testing.T) {
	p := NewSpooler("EvidencePrinter", "")
	p.lastJobID.Store(111) // stale RAW identity from an earlier completed job
	p.PDFPrintResult = func(context.Context, string, string) (string, error) {
		return "789", nil
	}
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF(), JobID: "pdf-evidence"}); err != nil {
		t.Fatalf("PDF result callback must succeed, got %v", err)
	}
	if got := p.LastSpoolerJobID(); got != "789" {
		t.Fatalf("PDF success must replace stale RAW job identity with GDI job 789, got %q", got)
	}
}

func TestPDFPrintFailureClearsStaleSpoolerJobID(t *testing.T) {
	p := NewSpooler("EvidencePrinter", "")
	p.lastJobID.Store(111)
	p.PDFPrintResult = func(context.Context, string, string) (string, error) {
		return "", errors.New("simulated GDI failure")
	}
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF(), JobID: "pdf-failure"}); err == nil {
		t.Fatal("PDF result callback must fail")
	}
	if got := p.LastSpoolerJobID(); got != "" {
		t.Fatalf("failed PDF attempt must not retain stale prior job identity, got %q", got)
	}
}

func TestPDFPrintFailurePreservesCurrentGDISpoolerJobID(t *testing.T) {
	p := NewSpooler("EvidencePrinter", "")
	p.lastJobID.Store(111)
	p.PDFPrintResult = func(context.Context, string, string) (string, error) {
		return "790", MarkUnknown("simulated GDI failure after StartDocW")
	}
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF(), JobID: "pdf-failure-evidence"}); err == nil {
		t.Fatal("PDF result callback must fail")
	}
	if got := p.LastSpoolerJobID(); got != "790" {
		t.Fatalf("failed PDF attempt must preserve current GDI job identity 790, got %q", got)
	}
}

func TestPDFPrintRejectsInvalidResultJobID(t *testing.T) {
	p := NewSpooler("EvidencePrinter", "")
	p.PDFPrintResult = func(context.Context, string, string) (string, error) {
		return "not-a-number", nil
	}
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF(), JobID: "pdf-invalid-id"}); err == nil {
		t.Fatal("invalid platform spooler identity must fail closed")
	}
	if got := p.LastSpoolerJobID(); got != "" {
		t.Fatalf("invalid platform identity must never be published, got %q", got)
	}
}

func TestPDFPrintCancellationBoundsBlockedGDIAndPreservesEarlyJobID(t *testing.T) {
	originalGrace := postCancelSpoolerResultGrace
	originalPlatform := platformPrintPDFObserved
	postCancelSpoolerResultGrace = 25 * time.Millisecond
	defer func() {
		postCancelSpoolerResultGrace = originalGrace
		platformPrintPDFObserved = originalPlatform
	}()

	started := make(chan struct{})
	release := make(chan struct{})
	platformPrintPDFObserved = func(_ context.Context, _ string, _ string, onJobID func(uint32)) (string, error) {
		if onJobID != nil {
			onJobID(812)
		}
		close(started)
		// Simulate a synchronous GDI/driver call that ignores context
		// cancellation and does not return until the OS call eventually does.
		<-release
		return "812", nil
	}

	p := NewSpooler("Blocked GDI Queue", "")
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := p.PrintDocument(ctx, Document{Kind: KindPDF, Data: validPDF(), JobID: "pdf-blocked-gdi"})
	elapsed := time.Since(start)
	if err == nil || !OutcomeUnknown(err) {
		close(release)
		t.Fatalf("blocked GDI after cancellation must return UNKNOWN, got %v", err)
	}
	if elapsed > time.Second {
		close(release)
		t.Fatalf("blocked GDI held caller for %v; expected bounded cancellation return", elapsed)
	}
	if got := p.LastSpoolerJobID(); got != "812" {
		close(release)
		t.Fatalf("StartDocW job identity was lost across bounded cancellation: got %q want 812", got)
	}
	select {
	case <-started:
	default:
		close(release)
		t.Fatal("fake GDI worker did not start")
	}

	// The caller returned, but the worker still owns the printer session. A
	// second physical session must not be allowed to overlap the uncertain one.
	if p.sessionMu.TryLock() {
		p.sessionMu.Unlock()
		close(release)
		t.Fatal("PDF caller released printer session while GDI worker was still active")
	}

	close(release)
	deadline := time.Now().Add(time.Second)
	for {
		if p.sessionMu.TryLock() {
			p.sessionMu.Unlock()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("PDF worker did not release printer session after the simulated GDI call returned")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSpoolerDeviceInfoPromotesPortAndDriverIdentity(t *testing.T) {
	info := spoolerDeviceInfo("Receipt Front", "USB001", "Generic Thermal", "online", PRINTER_ATTRIBUTE_LOCAL)
	if info.SpoolerPort != "USB001" || info.SpoolerDriver != "Generic Thermal" {
		t.Fatalf("spooler physical identity stayed capability-only: %#v", info)
	}
	if got := info.Capabilities["port_name"]; got != info.SpoolerPort {
		t.Fatalf("legacy capability port=%v does not match top-level identity %q", got, info.SpoolerPort)
	}
	if got := info.Capabilities["driver_name"]; got != info.SpoolerDriver {
		t.Fatalf("legacy capability driver=%v does not match top-level identity %q", got, info.SpoolerDriver)
	}

	renamed := spoolerDeviceInfo("Receipt Front Renamed", "USB001", "Generic Thermal", "online", PRINTER_ATTRIBUTE_LOCAL)
	if got, want := StableIDForDevice(renamed), StableIDForDevice(info); got != want {
		t.Fatalf("queue rename changed physical spooler identity: got %s want %s", got, want)
	}
}

func TestInteractiveUserSpoolerConnectionIsDiscoveryOnly(t *testing.T) {
	infos := []DeviceInfo{spoolerDeviceInfo(
		`\\print-server\receipt`,
		`\\print-server\receipt`,
		"Vendor Driver",
		"online",
		PRINTER_ATTRIBUTE_NETWORK,
	)}
	infos[0].Capabilities["spooler_scope"] = "user_connection"
	if marked := markInteractiveUserConnectionsCandidateOnly(infos, 3); marked != 1 {
		t.Fatalf("interactive per-user connection marked=%d want 1", marked)
	}
	if IsRuntimeDiscoveryPrinter(infos[0]) {
		t.Fatalf("interactive user's PRINTER_ENUM_CONNECTIONS queue entered service runtime inventory: %#v", infos[0])
	}
	if got := infos[0].Capabilities["candidate_reason"]; got != "per_user_spooler_connection" {
		t.Fatalf("candidate reason=%v, want per_user_spooler_connection", got)
	}
}

func TestSessionZeroSpoolerConnectionRemainsRuntimeEligible(t *testing.T) {
	infos := []DeviceInfo{spoolerDeviceInfo(
		`\\print-server\receipt`,
		`\\print-server\receipt`,
		"Vendor Driver",
		"online",
		PRINTER_ATTRIBUTE_NETWORK,
	)}
	infos[0].Capabilities["spooler_scope"] = "user_connection"
	if marked := markInteractiveUserConnectionsCandidateOnly(infos, 0); marked != 0 {
		t.Fatalf("Session-0 service connection marked candidate-only: %d", marked)
	}
	if !IsRuntimeDiscoveryPrinter(infos[0]) {
		t.Fatalf("service account's own Session-0 printer connection was rejected: %#v", infos[0])
	}
}

func TestInteractiveMachineLocalNetworkQueueRemainsRuntimeEligible(t *testing.T) {
	info := spoolerDeviceInfo(
		"Office TCP Queue",
		"IP_192.0.2.20",
		"Vendor Driver",
		"online",
		PRINTER_ATTRIBUTE_LOCAL|PRINTER_ATTRIBUTE_NETWORK,
	)
	info.Capabilities["spooler_scope"] = "machine_local"
	infos := []DeviceInfo{info}
	if marked := markInteractiveUserConnectionsCandidateOnly(infos, 3); marked != 0 {
		t.Fatalf("machine-local queue was mistaken for a per-user connection: %d", marked)
	}
	if !IsRuntimeDiscoveryPrinter(infos[0]) {
		t.Fatalf("machine-installed network queue became discovery-only: %#v", infos[0])
	}
}

func TestOpenPrinterFailureIsQueueAccessibilityUnknownNotPhysicalOffline(t *testing.T) {
	restore := setPrinterHooks(
		func(printerNamePtr *uint16) (syscall.Handle, error) {
			return 0, syscall.Errno(5) // ERROR_ACCESS_DENIED
		},
		fakePrinterInfo2(0, 0),
	)
	defer restore()

	err := preFlightSpoolerCheck("User-only Queue")
	if err == nil || !errors.Is(err, ErrPrinterNotReady) || !errors.Is(err, ErrSpoolerQueueInaccessible) {
		t.Fatalf("OpenPrinter failure must be typed inaccessible/not-ready, got %v", err)
	}
	if errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("OpenPrinter access failure is not physical offline evidence: %v", err)
	}

	p := &SpoolerPrinter{Name: "T", SpoolerName: "User-only Queue", Timeout: time.Second}
	if st := p.Status(); st != "unknown" {
		t.Fatalf("inaccessible service-context queue status=%q want unknown", st)
	}
}

func TestServerOfflineBitBlocksDispatchAndReportsOffline(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_SERVER_OFFLINE, 0)
	err := preFlightSpoolerCheck("Remote Server Offline")
	if err == nil || !errors.Is(err, ErrPrinterOffline) {
		t.Fatalf("SERVER_OFFLINE must be a concrete offline condition, got %v", err)
	}
	if dispatchErr := dispatchPreFlightSpoolerCheck("Remote Server Offline"); dispatchErr == nil || !errors.Is(dispatchErr, ErrPrinterOffline) {
		t.Fatalf("SERVER_OFFLINE must block spool submission, got %v", dispatchErr)
	}
	p := &SpoolerPrinter{Name: "T", SpoolerName: "Remote Server Offline", Timeout: time.Second}
	if st := p.Status(); st != "offline" {
		t.Fatalf("SERVER_OFFLINE heartbeat status=%q want offline", st)
	}
}

func TestSpoolerRejectedAttemptPreservesRunningJobIdentity(t *testing.T) {
	p := &SpoolerPrinter{SpoolerName: "RacePrinter", Name: "Race Printer"}
	// Simulate a still-running worker: session held, StartDoc identity published.
	p.sessionMu.Lock()
	defer p.sessionMu.Unlock()
	p.lastJobID.Store(12345)
	// A second attempt rejected before acquiring the session (here via an
	// already-cancelled context, before any Win32 call) must not erase the
	// running attempt's evidence. Previously Print cleared lastJobID on entry.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.Print(ctx, []byte("second attempt payload")); err == nil {
		t.Fatal("cancelled attempt must fail")
	}
	if got := p.lastJobID.Load(); got != 12345 {
		t.Fatalf("rejected attempt erased running job identity: got %d want 12345", got)
	}
	if got := p.LastSpoolerJobID(); got != "12345" {
		t.Fatalf("reporter must still publish the running job ID, got %q", got)
	}
}

func TestSpoolerQueueIdentityKeepsServerAndShareDistinct(t *testing.T) {
	// Two queues on the same port/driver but different servers (or shares)
	// are different printers: cross-server identity must retain provenance
	// so dedup never merges them into one inventory row.
	a := spoolerQueueDeviceInfo("Receipt", "USB001", "Generic Thermal", "PRINT-SRV-01", "ReceiptShare", "online", 0)
	b := spoolerQueueDeviceInfo("Receipt", "USB001", "Generic Thermal", "PRINT-SRV-02", "ReceiptShare", "online", 0)
	if a.SpoolerServer != "PRINT-SRV-01" || a.SpoolerShare != "ReceiptShare" {
		t.Fatalf("server/share provenance lost: %+v", a)
	}
	keyA, okA := physicalIdentityKey(a)
	keyB, okB := physicalIdentityKey(b)
	if !okA || !okB {
		t.Fatal("queue identity must resolve a physical key")
	}
	if keyA == keyB {
		t.Fatalf("cross-server queues share one identity key: %q", keyA)
	}
	// Identical coordinates stay identical (no spurious duplication).
	c := spoolerQueueDeviceInfo("Receipt", "USB001", "Generic Thermal", "PRINT-SRV-01", "ReceiptShare", "online", 0)
	keyC, _ := physicalIdentityKey(c)
	if keyA != keyC {
		t.Fatalf("identical queues diverged: %q vs %q", keyA, keyC)
	}
}
