//go:build windows

package printer

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestUSBUnprovenBindingCannotOpenOrWriteDevice(t *testing.T) {
	for _, reason := range []string{"not enumerated", "wrong IDs", "wrong serial", "enumeration failed"} {
		t.Run(reason, func(t *testing.T) {
			p := nativeUSBPrintFixture("blocked", "Blocked", `\\.\PhysicalDrive0`)
			switch reason {
			case "not enumerated":
				p.usbInterfaces = func() ([]usbPrintInterface, error) { return nil, nil }
			case "wrong IDs":
				p.PID++
			case "wrong serial":
				p.SerialNumber = "another-printer"
			case "enumeration failed":
				p.usbInterfaces = func() ([]usbPrintInterface, error) { return nil, errors.New("native enumeration failed") }
			}
			var opened, written atomic.Int32
			p.openDevice = func(*uint16, uint32) (windows.Handle, error) {
				opened.Add(1)
				return windows.InvalidHandle, errors.New("must not open an unproven device")
			}
			p.writeChunk = func(windows.Handle, []byte) (uint32, error) { written.Add(1); return 0, nil }
			err := p.Print(context.Background(), []byte("receipt"))
			if err == nil || !strings.Contains(err.Error(), "binding refused before opening") || HasUnknownOutcomeMarker(err.Error()) {
				t.Fatalf("binding refusal must remain pre-dispatch: %v", err)
			}
			p.transportObserved.Store(true)
			if status := p.Status(); status != "unknown" || p.TransportObserved() {
				t.Fatalf("unproven device observed as printer: %q", status)
			}
			if opened.Load() != 0 || written.Load() != 0 {
				t.Fatalf("unproven binding reached device: opens=%d writes=%d", opened.Load(), written.Load())
			}
		})
	}
}

func TestUSBCancelledNativeProofNeverOpensDeviceAfterReturning(t *testing.T) {
	p := nativeUSBPrintFixture("slow-proof", "Slow", "slow-proof-test")
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	workerReturning := make(chan struct{})
	p.usbInterfaces = func() ([]usbPrintInterface, error) {
		close(started)
		<-release
		defer close(workerReturning)
		return []usbPrintInterface{{path: p.DevicePath, instanceID: `USB\VID_1234&PID_5678\fixture`, devInst: 1}}, nil
	}
	var opened atomic.Int32
	p.openDevice = func(*uint16, uint32) (windows.Handle, error) {
		opened.Add(1)
		return windows.InvalidHandle, errors.New("must not open after cancelled proof")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.Print(ctx, []byte("receipt")) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("native proof did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || HasUnknownOutcomeMarker(err.Error()) {
			t.Fatalf("cancelled proof result: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled proof was not bounded")
	}
	// Ownership remains reserved while the abandoned native enumeration runs.
	if err := p.validateNativeBinding(context.Background()); !errors.Is(err, ErrSpoolerUnresponsive) {
		t.Fatalf("native proof worker ownership released too early: %v", err)
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-workerReturning:
	case <-time.After(2 * time.Second):
		t.Fatal("native proof did not finish")
	}
	deadline := time.After(2 * time.Second)
	for {
		spoolerPreflightOwnership.Lock()
		_, active := spoolerPreflightOwnership.active["usbprint slow-proof-test"]
		spoolerPreflightOwnership.Unlock()
		if !active {
			break
		}
		select {
		case <-deadline:
			t.Fatal("completed native proof retained worker ownership")
		case <-time.After(time.Millisecond):
		}
	}
	if opened.Load() != 0 {
		t.Fatalf("abandoned native proof opened %d handles", opened.Load())
	}
}

func TestUSBVerifiedBindingStillRequiresFreshAdmissionBeforeWriting(t *testing.T) {
	p := nativeUSBPrintFixture("admission", "Admission", "NUL")
	var writes, closes atomic.Int32
	p.writeChunk = func(windows.Handle, []byte) (uint32, error) { writes.Add(1); return 0, nil }
	p.closeHandle = func(h windows.Handle) error { closes.Add(1); return windows.CloseHandle(h) }
	refused := errors.New("printer was unshared during native preparation")
	ctx := WithDispatchAdmission(context.Background(), func(context.Context) error { return refused })
	err := p.Print(ctx, []byte("receipt"))
	if !errors.Is(err, refused) || HasUnknownOutcomeMarker(err.Error()) || writes.Load() != 0 || closes.Load() != 1 {
		t.Fatalf("fresh admission bypassed or leaked a handle: err=%v writes=%d closes=%d", err, writes.Load(), closes.Load())
	}
}

func TestUSBCancelledDeviceOpenClosesLateHandleWithoutWriting(t *testing.T) {
	p := nativeUSBPrintFixture("slow-open", "Slow Open", "slow-open-test")
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	closed := make(chan windows.Handle, 2)
	var writes atomic.Int32
	p.openDevice = func(*uint16, uint32) (windows.Handle, error) {
		close(started)
		<-release
		return windows.Handle(123), nil
	}
	p.closeHandle = func(handle windows.Handle) error { closed <- handle; return nil }
	p.writeChunk = func(windows.Handle, []byte) (uint32, error) { writes.Add(1); return 0, nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.Print(ctx, []byte("receipt")) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("native open did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || HasUnknownOutcomeMarker(err.Error()) {
			t.Fatalf("abandoned open is pre-dispatch: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("native open ignored caller cancellation")
	}
	if err := p.validateNativeBinding(context.Background()); !errors.Is(err, ErrSpoolerUnresponsive) {
		t.Fatalf("abandoned open lost native worker ownership: %v", err)
	}
	select {
	case <-closed:
		t.Fatal("handle was closed before the native open returned")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case handle := <-closed:
		if handle != windows.Handle(123) {
			t.Fatalf("closed wrong handle: %v", handle)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("late native handle was leaked")
	}
	deadline := time.After(2 * time.Second)
	for {
		spoolerPreflightOwnership.Lock()
		_, active := spoolerPreflightOwnership.active["usbprint slow-open-test"]
		spoolerPreflightOwnership.Unlock()
		if !active {
			break
		}
		select {
		case <-deadline:
			t.Fatal("native open worker retained ownership after cleanup")
		case <-time.After(time.Millisecond):
		}
	}
	select {
	case <-closed:
		t.Fatal("native handle closed twice")
	default:
	}
	if writes.Load() != 0 {
		t.Fatalf("abandoned open continued into %d writes", writes.Load())
	}
}
