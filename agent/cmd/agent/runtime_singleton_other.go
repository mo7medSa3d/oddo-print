//go:build !windows

package main

import (
	"path/filepath"

	"github.com/yaseir-agent/agent/internal/config"
)

// POSIX runtime singleton: flock a persistent lock file beside the resolved
// config so two agent processes can never share one queue.db. Without this,
// a second process (systemd + manual start, two terminals) would poll, claim
// and print the same jobs as the first — duplicate paper. The lock file is
// never unlinked; the OS releases the flock on process exit (including kill).
// The lock is per config directory (each config owns its queue.db);
// cf. the machine-global mutex in runtime_singleton_windows.go.
func acquireAgentRuntimeSingleton(configPath string) (func(), error) {
	dir := filepath.Dir(configPath)
	if absolute, err := filepath.Abs(configPath); err == nil {
		dir = filepath.Dir(absolute)
	}
	unlock, err := config.LockLocalFile(filepath.Join(dir, "agent.lock"))
	if err != nil {
		return nil, err
	}
	release := func() {
		_ = unlock()
	}
	return release, nil
}
