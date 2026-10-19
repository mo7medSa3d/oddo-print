package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRegistryPath(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	want := filepath.Join(filepath.Dir(configPath), "printers.json")
	if got := RegistryPath(configPath); got != want {
		t.Fatalf("RegistryPath(%q) = %q, want %q", configPath, got, want)
	}
}

func TestQueueDBPath(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	want := filepath.Join(filepath.Dir(configPath), "queue.db")
	if got := QueueDBPath(configPath); got != want {
		t.Fatalf("QueueDBPath(%q) = %q, want %q", configPath, got, want)
	}
}

func TestLocalFileLockExcludesIndependentHandlesAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "registry.lock")
	release, err := LockLocalFile(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		_ = release()
		t.Fatal(err)
	}
	defer second.Close()
	if unlock, err := tryLocalFileLock(second); !errors.Is(err, errLocalLockBusy) {
		if err == nil {
			_ = unlock()
		}
		_ = release()
		t.Fatalf("independent handle bypassed exclusive lock: %v", err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	unlock, err := tryLocalFileLock(second)
	if err != nil {
		t.Fatalf("lock was not released: %v", err)
	}
	if err := unlock(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("lock inode removed, permitting replacement-lock races")
	}
}
