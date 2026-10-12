package agent

import (
	"testing"
	"time"
)

func TestDiscoverySemaphoreReleasedOnNormalFinish(t *testing.T) {
	a := &Agent{discoverySem: make(chan struct{}, 1)}
	a.discoverySem <- struct{}{}
	finished := make(chan struct{})
	close(finished)
	a.releaseDiscoverySemaphoreWhenFinished(finished, time.Minute)
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case <-a.discoverySem:
			if a.discoveryWedged.Load() {
				t.Fatal("normal finish must not mark the scan wedged")
			}
			return
		default:
			if time.Now().After(deadline) {
				t.Fatal("semaphore was not released after normal finish")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
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
