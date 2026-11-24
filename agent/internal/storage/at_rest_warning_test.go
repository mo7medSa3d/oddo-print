package storage

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestAtRestWarningFiresOnRead proves an agent that only LOADS a credential
// from a pre-existing store file still warns about the missing at-rest
// protection. SaveSecret only warns on the write path, so a store file
// written by another process would otherwise be read silently.
func TestAtRestWarningFiresOnRead(t *testing.T) {
	if platformAtRestWarning() == "" {
		t.Skip("platform has sealed storage; no at-rest warning to emit")
	}

	// Capture the log output the warning is written to.
	var captured strings.Builder
	log.SetOutput(&captured)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(log.LstdFlags)
	})

	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "agent-secrets.dat"))
	if err := store.SaveSecret("agent-secret", "value"); err != nil {
		t.Fatalf("SaveSecret: %v", err)
	}
	captured.Reset()

	// Simulate a process that only READS the credential: the write path
	// already consumed the once-per-process warning.
	atRestWarningOnce = sync.Once{}

	// A fresh store object reading the SAME file exercises the read path only.
	reader := NewStore(filepath.Join(dir, "agent-secrets.dat"))
	if _, err := reader.GetSecret("agent-secret"); err != nil {
		t.Fatalf("GetSecret: %v", err)
	}
	if !strings.Contains(captured.String(), "at-rest") {
		t.Fatalf("reading a stored credential must emit the at-rest warning, got: %q", captured.String())
	}
}
