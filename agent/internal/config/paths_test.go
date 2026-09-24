package config

import (
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
