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
	result, completed, finished := runBoundedDiscovery(ctx, 20*time.Millisecond, func(context.Context) printer.DiscoveryResult {
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
