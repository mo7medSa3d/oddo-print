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

func nativeUSBPrintFixture(id, name, path string) *USBPrinter {
	return &USBPrinter{
		ID: id, Name: name, DevicePath: path, VID: 0x1234, PID: 0x5678,
		usbInterfaces: func() ([]usbPrintInterface, error) {
			return []usbPrintInterface{{path: path, instanceID: `USB\VID_1234&PID_5678\fixture`, devInst: 1}}, nil
		},
	}
}

func TestUSBWriteCancelledBeforeDispatchIsPlain(t *testing.T) {
	p := nativeUSBPrintFixture("u1", "U1", "NUL")
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
	p := nativeUSBPrintFixture("u2b", "U2B", "NUL")
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
	p := nativeUSBPrintFixture("u2", "U2", "NUL")
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

func TestUSBWriteZeroByteFailureIsUnknown(t *testing.T) {
	p := nativeUSBPrintFixture("u3", "U3", "NUL")
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		return 0, errors.New("device rejected transfer")
	}
	err := p.Print(context.Background(), []byte("hello"))
	if err == nil {
		t.Fatal("expected write failure")
	}
	// WriteFile resets its byte counter before calling the driver. Zero
	// confirmed bytes after failure is NOT proof of zero device delivery.
	if !HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("zero confirmed bytes after a failed in-flight WriteFile must prevent automatic duplicate printing: %v", err)
	}
}

func TestUSBWriteExceedingBoundaryIsUnknownAndWedges(t *testing.T) {
	old := usbChunkTimeout
	usbChunkTimeout = 150 * time.Millisecond
	defer func() { usbChunkTimeout = old }()

	p := nativeUSBPrintFixture("u4", "U4", "NUL")
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
	p := nativeUSBPrintFixture("u5", "U5", "NUL")
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
	p := nativeUSBPrintFixture("u6", "U6", "NUL")
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
	p := nativeUSBPrintFixture("u7", "U7", "NUL")
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
	if zplPayload != "^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n" || !strings.HasPrefix(zplPayload, "^XA") || strings.Count(zplPayload, "^XZ") != 1 || strings.Contains(zplPayload, "~JA") {
		t.Fatalf("ZPL test payload must be framed once and sanitize command delimiters, got %q", zplPayload)
	}

	tspl := &USBPrinter{ID: "tspl", Name: "Label \"\nPRINT 9,9", Protocol: "tspl"}
	tsplPayload := string(tspl.testPayload())
	if tsplPayload != "SELFTEST\r\n" ||
		strings.Contains(tsplPayload, "SIZE ") || strings.Contains(tsplPayload, "GAP ") ||
		strings.Contains(tsplPayload, "\"\nPRINT 9,9") ||
		strings.Contains(tsplPayload, "\nPRINT 9,9\n") {
		t.Fatalf("TSPL test payload must emit one native diagnostic without stock guesses or attacker commands, got %q", tsplPayload)
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
