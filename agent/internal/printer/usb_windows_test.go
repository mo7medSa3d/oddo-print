//go:build windows

package printer

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The synchronous Win32 WriteFile has no deadline: once the call is in the
// kernel, context cancellation cannot interrupt it (documented Windows
// behavior). These tests prove the isolation MECHANISM around that fact —
// caller boundedness, honest outcome classification, and the wedge latch —
// using an injected write function. Behavior against real wedged hardware
// additionally requires a physical device stall, which CI cannot provide.

func TestUSBWriteCancelledBeforeDispatchIsPlain(t *testing.T) {
	p := &USBPrinter{ID: "u1", Name: "U1", DevicePath: "NUL"}
	called := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		called.Add(1)
		return uint32(len(chunk)), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := p.Print(ctx, []byte("hello"))
	if err == nil {
		t.Fatal("pre-cancelled print must fail")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("cancellation BEFORE any byte was queued is provably pre-dispatch and must stay plain: %v", err)
	}
	if called.Load() != 0 {
		t.Fatalf("no kernel write may start after cancellation: %d calls", called.Load())
	}
}

func TestUSBWritePartialBytesThenErrorIsUnknown(t *testing.T) {
	p := &USBPrinter{ID: "u2b", Name: "U2B", DevicePath: "NUL"}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		return 3, errors.New("write completed partially then reported an error")
	}
	err := p.Print(context.Background(), make([]byte, 20))
	if err == nil {
		t.Fatal("expected write failure")
	}
	if !HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("bytes reported together with an error are physically ambiguous and must be unknown: %v", err)
	}
}

func TestUSBWritePartialThenErrorIsUnknown(t *testing.T) {
	p := &USBPrinter{ID: "u2", Name: "U2", DevicePath: "NUL"}
	calls := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		if calls.Add(1) == 1 {
			return 3, nil // partial delivery of the first chunk
		}
		return 0, errors.New("device reset mid-transfer")
	}
	err := p.Print(context.Background(), make([]byte, 20))
	if err == nil {
		t.Fatal("expected failure after partial write")
	}
	if !HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("partial write must be classified unknown: %v", err)
	}
}

func TestUSBWriteZeroByteFailureStaysPlain(t *testing.T) {
	p := &USBPrinter{ID: "u3", Name: "U3", DevicePath: "NUL"}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		return 0, errors.New("device rejected transfer")
	}
	err := p.Print(context.Background(), []byte("hello"))
	if err == nil {
		t.Fatal("expected write failure")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("a write that synchronously failed with zero confirmed bytes is provably pre-dispatch and must stay plain: %v", err)
	}
}

func TestUSBWriteExceedingBoundaryIsUnknownAndWedges(t *testing.T) {
	old := usbChunkTimeout
	usbChunkTimeout = 150 * time.Millisecond
	defer func() { usbChunkTimeout = old }()

	p := &USBPrinter{ID: "u4", Name: "U4", DevicePath: "NUL"}
	release := make(chan struct{})
	calls := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		calls.Add(1)
		<-release // wedged device: the kernel call never returns
		return uint32(len(chunk)), nil
	}
	start := time.Now()
	err := p.Print(context.Background(), []byte("hello"))
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("stalled write must fail")
	}
	if !HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("a write abandoned mid-syscall may already have transmitted bytes and must be unknown: %v", err)
	}
	if !strings.Contains(err.Error(), "operation boundary") || !strings.Contains(err.Error(), "unknown number of transmitted bytes") {
		t.Fatalf("timeout error must say what happened: %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("caller was not bounded: Print blocked %v", elapsed)
	}
	if !p.wedged.Load() {
		t.Fatal("abandoned in-flight write must latch the printer wedged")
	}
	before := calls.Load()
	// A wedged printer refuses new dispatches WITHOUT touching hardware:
	// no second job may interleave bytes with the abandoned write.
	err = p.Print(context.Background(), []byte("second job"))
	if err == nil {
		t.Fatal("wedged printer must refuse new dispatch")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("wedged refusal happens before any byte and must be a plain pre-dispatch error: %v", err)
	}
	if calls.Load() != before {
		t.Fatalf("wedged refusal must not reach the device: calls %d -> %d", before, calls.Load())
	}
	close(release)
}

func TestUSBWriteCancelledInFlightIsUnknown(t *testing.T) {
	p := &USBPrinter{ID: "u5", Name: "U5", DevicePath: "NUL"}
	release := make(chan struct{})
	defer close(release)
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		<-release // blocks: in-flight kernel write
		return uint32(len(chunk)), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		n, err, transferred := p.writeChunkBounded(windows.Handle(0), []byte("hello"), ctx.Done())
		if err == nil {
			done <- nil
			return
		}
		if n != 0 {
			t.Errorf("abandoned write must report zero CONFIRMED bytes, got %d", n)
		}
		if !transferred {
			t.Error("cancellation must transfer handle ownership to the write helper")
		}
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error after cancellation")
		}
		if !HasUnknownOutcomeMarker(err.Error()) {
			t.Fatalf("cancellation of an in-flight kernel write is ambiguous and must be unknown: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("writeChunkBounded did not respect cancellation")
	}
}

func TestUSBCancelledPrintClosesHandleOnlyAfterAbandonedWriteReturns(t *testing.T) {
	p := &USBPrinter{ID: "u6", Name: "U6", DevicePath: "NUL"}
	started := make(chan struct{})
	release := make(chan struct{})
	closed := make(chan struct{}, 1)
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		close(started)
		<-release
		return uint32(len(chunk)), nil
	}
	p.closeHandle = func(h windows.Handle) error {
		err := windows.CloseHandle(h)
		closed <- struct{}{}
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Print(ctx, []byte("hello")) }()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("write helper did not start")
	}
	cancel()

	select {
	case err := <-done:
		if err == nil || !HasUnknownOutcomeMarker(err.Error()) {
			t.Fatalf("in-flight cancellation must return an unknown outcome, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Print did not respect cancellation")
	}

	select {
	case <-closed:
		t.Fatal("Print closed the device handle while the abandoned helper still owned the write")
	default:
	}

	close(release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("abandoned write helper did not close its transferred handle after returning")
	}
}

func TestUSBCompletedPrintClosesCallerOwnedHandleExactlyOnce(t *testing.T) {
	p := &USBPrinter{ID: "u7", Name: "U7", DevicePath: "NUL"}
	closed := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		return uint32(len(chunk)), nil
	}
	p.closeHandle = func(h windows.Handle) error {
		closed.Add(1)
		return windows.CloseHandle(h)
	}
	if err := p.Print(context.Background(), []byte("hello")); err != nil {
		t.Fatalf("completed print failed: %v", err)
	}
	if got := closed.Load(); got != 1 {
		t.Fatalf("completed print must close its caller-owned handle exactly once, got %d", got)
	}
}

func TestUSBProtocolSupportRequiresExplicitESCPOS(t *testing.T) {
	raw := &USBPrinter{ID: "raw", Name: "Raw USB", Protocol: "raw"}
	if !raw.SupportsKind(KindRaw) {
		t.Fatal("explicit raw USB must support raw bytes")
	}
	if raw.SupportsKind(KindESCPOS) {
		t.Fatal("generic raw USB must not infer ESC/POS support")
	}
	escpos := &USBPrinter{ID: "esc", Name: "Receipt", Protocol: "escpos", SupportsESCPOS: true}
	if !escpos.SupportsKind(KindRaw) || !escpos.SupportsKind(KindESCPOS) {
		t.Fatal("explicit ESC/POS USB must support its byte-stream payloads")
	}
}

func TestUSBTestPayloadDoesNotInjectESCPOSWithoutCapability(t *testing.T) {
	raw := &USBPrinter{ID: "raw", Name: "Office USB", Protocol: "raw", VID: 0x1234, PID: 0x5678}
	payload := raw.testPayload()
	if strings.Contains(string(payload), "\x1b") || strings.Contains(string(payload), "\x1d") {
		t.Fatalf("generic raw USB test payload must be printable text only: %q", payload)
	}
	escpos := &USBPrinter{ID: "esc", Name: "Receipt", Protocol: "escpos", SupportsESCPOS: true}
	payload = escpos.testPayload()
	if !strings.HasPrefix(string(payload), "\x1b@") {
		t.Fatalf("explicit ESC/POS test should initialize the printer, got %q", payload)
	}
	if strings.Contains(string(payload), "\x1dV") {
		t.Fatal("diagnostic must not infer cutter support")
	}
}

func TestUSBLabelProtocolTestPayloadsUseTheirDeclaredLanguage(t *testing.T) {
	zpl := &USBPrinter{ID: "zpl", Name: "Label ^XZ ~JA", Protocol: "zpl"}
	zplPayload := string(zpl.testPayload())
	if !strings.HasPrefix(zplPayload, "^XA") || strings.Count(zplPayload, "^XZ") != 1 || strings.Contains(zplPayload, "~JA") {
		t.Fatalf("ZPL test payload must be framed once and sanitize command delimiters, got %q", zplPayload)
	}

	tspl := &USBPrinter{ID: "tspl", Name: "Label \"\nPRINT 9,9", Protocol: "tspl"}
	tsplPayload := string(tspl.testPayload())
	if !strings.Contains(tsplPayload, "CLS\n") ||
		strings.Count(tsplPayload, "PRINT 1,1") != 1 ||
		strings.Contains(tsplPayload, "\"\nPRINT 9,9") ||
		strings.Contains(tsplPayload, "\nPRINT 9,9\n") {
		t.Fatalf("TSPL test payload must keep attacker text inside the field and emit one fixed print command, got %q", tsplPayload)
	}
}

func TestUSBStatusDoesNotTreatInterfaceAccessAsPhysicalHealth(t *testing.T) {
	missing := &USBPrinter{ID: "u", Name: "USB", Protocol: "raw"}
	if got := missing.Status(); got != "unknown" {
		t.Fatalf("pathless USB status=%q want unknown", got)
	}
	inaccessible := &USBPrinter{ID: "u2", Name: "USB", Protocol: "raw", DevicePath: `\\?\usb#definitely_missing_yaseir_test`}
	if got := inaccessible.Status(); got != "unknown" {
		t.Fatalf("inaccessible USB interface status=%q want unknown, not physical offline", got)
	}
}
