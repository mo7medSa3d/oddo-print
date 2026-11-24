package printer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRegistryPersistUsesAtomicReplace pins the registry write to the shared
// atomic replace helper. A plain rename loses the Windows-specific
// MOVEFILE_WRITE_THROUGH durability and the transient-lock retry, so a
// scanner holding the destination open would fail the whole save and lose
// the discovered inventory.
func TestRegistryPersistUsesAtomicReplace(t *testing.T) {
	raw, err := os.ReadFile("registry.go")
	if err != nil {
		t.Fatalf("read registry.go: %v", err)
	}
	source := string(raw)
	if !strings.Contains(source, "config.ReplaceFile(tmpName, registryPath)") {
		t.Fatal("the registry must be persisted with config.ReplaceFile so the write is atomic and retries transient locks")
	}
}

// TestRegistryPersistReplacesExistingFile proves the atomic replace actually
// overwrites an existing registry in place.
func TestRegistryPersistReplacesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "printers.json")
	if err := os.WriteFile(path, []byte("[]"), 0o600); err != nil {
		t.Fatalf("seed registry: %v", err)
	}
	if _, err := RegisterManual(path, DeviceInfo{
		ID:             "net_1",
		Name:           "Net Printer",
		PrinterType:    "laser",
		ConnectionType: "network",
		Endpoint:       "192.168.10.10:9100",
		Protocol:       "raw",
		Status:         "unknown",
		Enabled:        true,
	}); err != nil {
		t.Fatalf("RegisterManual over an existing registry: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read registry: %v", err)
	}
	if !strings.Contains(string(raw), "net_1") {
		t.Fatalf("the replaced registry should contain the new printer, got %s", raw)
	}
}
