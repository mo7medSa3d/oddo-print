package agent

import (
	"testing"
	"time"
)

func TestDiscoverySemaphoreReleasedOnNormalFinish(t *testing.T) {
	a := &Agent{discoverySem: make(chan struct{}, 1)}
	a.discoverySem <- struct{}{}
	finished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(finished, time.Minute)
	select {
	case a.discoverySem <- struct{}{}:
		t.Fatal("unfinished scan must retain its discovery slot")
	default:
	}
	close(finished)
	// A successor acquires by sending only after cleanup drains the held slot.
	select {
	case a.discoverySem <- struct{}{}:
	case <-time.After(5 * time.Second):
		t.Fatal("semaphore was not released after normal finish")
	}
	if a.discoveryWedged.Load() {
		t.Fatal("normal finish must not mark the scan wedged")
	}
	<-a.discoverySem // Drain the successor slot acquired by this test.
}

func TestDiscoverySemaphoreForceReleasedWhenScanWedges(t *testing.T) {
	a := &Agent{discoverySem: make(chan struct{}, 1)}
	a.discoverySem <- struct{}{}
	finished := make(chan struct{})
	a.releaseDiscoverySemaphoreWhenFinished(finished, 50*time.Millisecond)
	// The watchdog recycles the slot so a successor scan can proceed.
	select {
	case a.discoverySem <- struct{}{}:
	case <-time.After(5 * time.Second):
		t.Fatal("wedged scan pinned discovery past the force-release bound")
	}
	if !a.discoveryWedged.Load() {
		t.Fatal("wedged scan must be flagged")
	}
	// The late finisher must not free the successor's slot. The force-release
	// waiter already exited via its timer branch, so no goroutine observes
	// this close; assert synchronously with no sleep.
	close(finished)
	select {
	case <-a.discoverySem:
		// Drains our own test acquisition: the late finish released nothing.
	default:
		t.Fatal("late finish stole the successor slot")
	}
}
