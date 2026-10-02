package main

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestProgramStopBeforeStart ensures Stop on a never-started program is a
// no-op rather than a nil dereference (SCM can in principle stop a service
// whose Start never ran).
func TestProgramStopBeforeStart(t *testing.T) {
	p := &program{}
	if err := p.Stop(nil); err != nil {
		t.Fatalf("Stop before Start: %v", err)
	}
}

// TestProgramStartStopLifecycle exercises the Start-owned goroutine against
// a concurrent Stop under the race detector: publication of
// ctx/cancel/runDone (Start) raced with consumption (Stop) and the
// setAgent/getAgent pointer handoff. The temp config is unpaired, so the
// goroutine idles in the pairing backoff and Stop must return promptly.
func TestProgramStartStopLifecycle(t *testing.T) {
	p := &program{configPath: filepath.Join(t.TempDir(), "agent.yaml")}
	if err := p.Start(nil); err != nil {
		t.Fatalf("Start: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				p.setAgent(nil)
				_ = p.getAgent()
			}
		}()
	}
	wg.Wait()

	done := make(chan error, 1)
	go func() { done <- p.Stop(nil) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Stop: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("Stop did not return within 25s (shutdown deadlock)")
	}

	// A second Stop after a clean shutdown must also be safe: cancel fires
	// again, runDone is already closed, no agent was ever published.
	if err := p.Stop(nil); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
}
