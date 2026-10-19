package agent

import (
	"context"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
)

func TestRunBoundedDiscoveryReturnsBeforeUncancellableWorkerFinishes(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	ctx := context.Background()

	start := time.Now()
	result, completed, finished := runBoundedDiscovery(ctx, 20*time.Millisecond, func(context.Context, printer.DiscoveryProgressFunc) printer.DiscoveryResult {
		close(started)
		<-release // simulate a synchronous Win32 call that ignores context cancellation
		return printer.DiscoveryResult{}
	})
	<-started
	if completed {
		t.Fatal("blocked discovery must not report completion")
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("bounded orchestration returned too slowly: %v", elapsed)
	}

	select {
	case <-finished:
		t.Fatal("uncancellable worker should still be running after orchestration timeout")
	default:
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("worker did not finish after release")
	}
	_ = result
}

// A slow, uncancellable source used to make orchestration throw away every
// observation the other sources had already produced.
func TestRunBoundedDiscoveryPreservesPartialResultsWhenBoundExpires(t *testing.T) {
	defer func() {
		finished := make(chan struct{})
		close(finished)
		<-finished
	}()

	release := make(chan struct{})
	started := make(chan struct{})
	ctx := context.Background()

	result, completed, finished := runBoundedDiscovery(ctx, 20*time.Millisecond,
		func(_ context.Context, onProgress printer.DiscoveryProgressFunc) printer.DiscoveryResult {
			// Two fast sources report their findings before the slow one blocks.
			onProgress(printer.DiscoveryResult{
				Printers:        []printer.DeviceInfo{{ID: "p1", Name: "Front"}, {ID: "p2", Name: "Back"}},
				CompleteSources: map[string]bool{printer.SourceConfig: true, printer.SourceSpooler: true},
			})
			close(started)
			<-release // an uncancellable Win32 call: EnumPrintersW / SetupDi
			return printer.DiscoveryResult{
				Printers: []printer.DeviceInfo{{ID: "p1"}, {ID: "p2"}, {ID: "p3"}},
			}
		})
	<-started

	if !completed {
		t.Fatal("a scan that already produced observations must be reported as bounded, not failed")
	}
	if len(result.Printers) != 2 {
		t.Fatalf("partial discovery lost observations: got %d printers, want 2", len(result.Printers))
	}
	if !result.Truncated {
		t.Fatal("a bound-expired result must be marked Truncated so absence is never reconciled as removal")
	}
	if !result.CompleteSources[printer.SourceSpooler] {
		t.Fatal("completed sources must still be recorded, otherwise safe absence reconciliation breaks")
	}
	if len(result.Errors) == 0 {
		t.Fatal("a truncated result must explain itself to the operator")
	}

	select {
	case <-finished:
		t.Fatal("uncancellable worker should still be running after orchestration timeout")
	default:
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("worker did not finish after release")
	}
}

// No observations at all means nothing was learned: the run is a failure, not a
// partial inventory.
func TestRunBoundedDiscoveryWithoutObservationsIsNotPartial(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})

	_, completed, finished := runBoundedDiscovery(context.Background(), 20*time.Millisecond,
		func(context.Context, printer.DiscoveryProgressFunc) printer.DiscoveryResult {
			close(started)
			<-release
			return printer.DiscoveryResult{}
		})
	<-started
	if completed {
		t.Fatal("a scan with no observations must not report a partial inventory")
	}
	close(release)
	<-finished
}

func TestDiscoverySemaphoreReleaseWaiterDoesNotBlockRuntimeWG(t *testing.T) {
	a := &Agent{discoverySem: make(chan struct{}, 1)}
	a.discoverySem <- struct{}{}
	finished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(finished)

	waited := make(chan struct{})
	go func() {
		a.runtimeWG.Wait()
		close(waited)
	}()
	select {
	case <-waited:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("uninterruptible discovery cleanup must not keep runtimeWG alive")
	}
	if len(a.discoverySem) != 1 {
		t.Fatal("semaphore must remain owned while the OS discovery worker is still running")
	}
	close(finished)
	deadline := time.Now().Add(time.Second)
	for len(a.discoverySem) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(a.discoverySem) != 0 {
		t.Fatal("semaphore was not released when the underlying discovery worker finished")
	}
}
