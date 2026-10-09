//go:build windows

package printer

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestPreflightTimeoutRetainsNativeWorkerOwnership(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	firstResult := make(chan error, 1)
	go func() {
		firstResult <- runPreflightBounded("Printer-Wedged-Case", 40*time.Millisecond, context.Background(), func() error {
			close(started)
			<-release
			return nil
		})
	}()
	<-started
	if err := <-firstResult; !errors.Is(err, ErrSpoolerUnresponsive) {
		t.Fatalf("stuck preflight not typed unresponsive: %v", err)
	}
	// Same queue with another instance/call site must fail before spawning a
	// second native worker, even though the previous caller has timed out.
	start := time.Now()
	err := runPreflightBounded("printer-wedged-case", time.Second, context.Background(), func() error {
		t.Error("second worker must not start")
		return nil
	})
	if !errors.Is(err, ErrSpoolerUnresponsive) || time.Since(start) > 300*time.Millisecond {
		t.Fatalf("timed-out worker released queue ownership too soon: err=%v", err)
	}
	close(release)
	deadline := time.After(2 * time.Second)
	for {
		err = runPreflightBounded("Printer-Wedged-Case", time.Second, context.Background(), func() error { return nil })
		if err == nil {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("worker ownership not cleared after RPC returned: %v", err)
		case <-time.After(time.Millisecond):
		}
	}
}

func TestWindowsPreflightGlobalWorkerBudget(t *testing.T) {
	var wg sync.WaitGroup
	started := make(chan struct{}, maxOutstandingSpoolerPreflights)
	release := make(chan struct{})
	var closeOnce sync.Once
	defer closeOnce.Do(func() { close(release) })
	for i := 0; i < maxOutstandingSpoolerPreflights; i++ {
		id := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = runPreflightBounded(fmt.Sprintf("budget-queue-%d", id), 40*time.Millisecond, context.Background(), func() error {
				started <- struct{}{}
				<-release
				return nil
			})
		}()
	}
	for i := 0; i < maxOutstandingSpoolerPreflights; i++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatalf("expected %d concurrent helpers, observed %d", maxOutstandingSpoolerPreflights, i)
		}
	}
	wg.Wait() // bounded callers return, native workers are still blocked
	if err := runPreflightBounded("budget-overflow-queue", time.Second, context.Background(), func() error {
		t.Error("over-budget helper must not run")
		return nil
	}); !errors.Is(err, ErrSpoolerUnresponsive) {
		t.Fatalf("global budget did not refuse new helper: %v", err)
	}
	closeOnce.Do(func() { close(release) })
	deadline := time.After(2 * time.Second)
	for {
		spoolerPreflightOwnership.Lock()
		active := len(spoolerPreflightOwnership.active)
		spoolerPreflightOwnership.Unlock()
		if active == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("abandoned native workers not reaped after release: %d", active)
		case <-time.After(time.Millisecond):
		}
	}
}
