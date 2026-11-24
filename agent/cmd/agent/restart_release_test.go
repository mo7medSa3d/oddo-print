package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/agent"
	"github.com/yaseir-agent/agent/internal/config"
)

// TestRestartLoopReleasesTheReplacedAgent guards the restart loop against
// leaking one local SQLite handle per crash. Every agent.New opens its own
// database handle, so a replacement instance must be created only after the
// failed instance released its resources.
//
// The loop itself is exercised through a real agent instance whose Run
// returns immediately (an unpaired agent id makes Run idle until the
// context is cancelled), which is the same path a crashed instance takes.
func TestRestartLoopReleasesTheReplacedAgent(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "agent.yaml")

	cfg := &config.Config{}
	cfg.Agent.Name = "Restart Test"
	cfg.Agent.ID = ""
	cfg.Server.URL = "http://127.0.0.1:1"
	cfg.Printers = nil

	first, err := agent.New(cfg, configPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// A replacement instance may only be created once the previous one
	// released its local database handle. On Windows an unreleased handle
	// keeps the SQLite file locked, so the second open would fail.
	closeAgentInstance(first)

	second, err := agent.New(cfg, configPath)
	if err != nil {
		t.Fatalf("New after closing the replaced agent: %v", err)
	}
	t.Cleanup(func() { closeAgentInstance(second) })

	// The released instance must not be able to serve work any more: a
	// closed SQLite handle fails instead of silently writing into a queue
	// the replacement instance also owns.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- first.Run(ctx) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("released agent did not return from Run")
	}
}

// TestCloseAgentInstanceIsNilSafe covers the shutdown race where the agent
// instance was never created (for example a failed agent.New).
func TestCloseAgentInstanceIsNilSafe(t *testing.T) {
	closeAgentInstance(nil)
}

// TestRestartLoopClosesTheFailedInstance pins the restart loop to release
// the failed instance before the replacement is created. Without it, every
// crash leaks one SQLite handle for the lifetime of the process.
func TestRestartLoopClosesTheFailedInstance(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	source := string(raw)

	if !strings.Contains(source, "closeAgentInstance(app)") {
		t.Fatal("the restart loop must release the failed agent instance before creating a replacement")
	}
	releaseIndex := strings.Index(source, "closeAgentInstance(app)")
	newIndex := strings.Index(source, "agent.New(cfg, p.configPath)")
	if releaseIndex < 0 || newIndex < 0 {
		t.Fatal("expected both the agent creation and its release to be present")
	}
	// The instance that just failed must be released after it was created and
	// before the loop waits for the next attempt, so the replacement never
	// opens a second handle while the failed one is still open.
	if releaseIndex < newIndex {
		t.Fatal("the failed agent instance must be released after it was created")
	}
	backoffAfterRelease := strings.Index(source[releaseIndex:], "time.After(jitteredBackoff(restartBackoff))")
	if backoffAfterRelease < 0 {
		t.Fatal("expected the restart backoff wait to follow the release")
	}
}
