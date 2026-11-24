package agent

import (
	"testing"
	"time"
)

// TestDiscoveryAbandonedScansAreCapped proves a permanently wedged driver
// cannot leak one goroutine per force-release window forever.
//
// Each force-release abandons a worker blocked in uncancellable OS I/O. After
// the cap, the semaphore is NOT recycled, so no successor scan can start and
// no further goroutine can be abandoned.
func TestDiscoveryAbandonedScansAreCapped(t *testing.T) {
	a := &Agent{discoverySem: make(chan struct{}, 1)}

	// The first abandonment is recovered: the slot is recycled.
	a.discoverySem <- struct{}{}
	firstFinished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(firstFinished, 30*time.Millisecond)
	select {
	case a.discoverySem <- struct{}{}:
		// Recycled as expected.
	case <-time.After(5 * time.Second):
		t.Fatal("first wedged scan was not force-released")
	}
	if got := a.discoveryAbandoned.Load(); got != 1 {
		t.Fatalf("expected one abandoned scan after the first force-release, got %d", got)
	}
	<-a.discoverySem

	// The second abandonment is also recovered (cap is 2).
	a.discoverySem <- struct{}{}
	secondFinished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(secondFinished, 30*time.Millisecond)
	select {
	case a.discoverySem <- struct{}{}:
	case <-time.After(5 * time.Second):
		t.Fatal("second wedged scan was not force-released")
	}
	if got := a.discoveryAbandoned.Load(); got != 2 {
		t.Fatalf("expected two abandoned scans after the second force-release, got %d", got)
	}
	<-a.discoverySem

	// The third abandonment exceeds the cap: the slot is NOT recycled, so no
	// successor scan can start and no further goroutine can be leaked.
	a.discoverySem <- struct{}{}
	thirdFinished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(thirdFinished, 30*time.Millisecond)
	select {
	case a.discoverySem <- struct{}{}:
		t.Fatal("semaphore must not be recycled past the abandoned-scan cap")
	case <-time.After(2 * time.Second):
		// Expected: the slot stays held.
	}
	if got := a.discoveryAbandoned.Load(); got != discoveryMaxAbandonedScans+1 {
		t.Fatalf("abandoned count must stop at the cap boundary, got %d", got)
	}
	if !a.discoveryWedged.Load() {
		t.Fatal("a wedged scan must remain visible in diagnostics")
	}
	close(thirdFinished)
}

// TestDiscoverySemaphoreNotReleasedWhenAbandonedCapReached proves the cap
// leaves the slot held, so a successor scan cannot start and leak another
// goroutine.
func TestDiscoverySemaphoreNotReleasedWhenAbandonedCapReached(t *testing.T) {
	a := &Agent{discoverySem: make(chan struct{}, 1)}
	a.discoveryAbandoned.Store(discoveryMaxAbandonedScans)

	a.discoverySem <- struct{}{}
	finished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(finished, 30*time.Millisecond)

	select {
	case a.discoverySem <- struct{}{}:
		t.Fatal("semaphore must stay held once the abandoned-scan cap is reached")
	case <-time.After(2 * time.Second):
		// Expected.
	}
	close(finished)
}
