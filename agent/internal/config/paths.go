package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// RegistryPath returns the persistent printer registry path associated with
// the agent configuration file. Keep this helper in the config package because
// callers use it as the storage-path contract for discovered/manual printers.
func RegistryPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if absolute, err := filepath.Abs(configPath); err == nil {
		dir = filepath.Dir(absolute)
	}
	return filepath.Join(dir, "printers.json")
}

// QueueDBPath returns the local durable print-queue database path associated
// with the agent configuration file. Relative paths resolve from the working
// directory, matching Load, Ensure, Save and secret storage.
func QueueDBPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if absolute, err := filepath.Abs(configPath); err == nil {
		dir = filepath.Dir(absolute)
	}
	return filepath.Join(dir, "queue.db")
}

var errLocalLockBusy = errors.New("local file lock is held")

// LockLocalFile serializes cooperating processes without replacing the lock
// inode when the protected JSON file is atomically replaced. The persistent
// lock file is intentionally never unlinked; the OS releases locks on exit.
func LockLocalFile(path string) (func() error, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if err := EnsureSecureDirectoryACL(filepath.Dir(path)); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := EnsureSecureFileACL(path); err != nil {
		_ = file.Close()
		return nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		unlock, err := tryLocalFileLock(file)
		if err == nil {
			return func() error { return errors.Join(unlock(), file.Close()) }, nil
		}
		if !errors.Is(err, errLocalLockBusy) || !time.Now().Before(deadline) {
			_ = file.Close()
			return nil, fmt.Errorf("acquire local lock %s: %w", path, err)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
