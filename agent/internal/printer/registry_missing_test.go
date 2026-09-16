package printer

import (
	"path/filepath"
	"testing"
)

func TestLoadRegistryPrintersMissingFileIsFirstRunState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	got, err := LoadRegistryPrinters(path)
	if err != nil {
		t.Fatalf("missing registry should not be an error, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil printer slice for missing registry, got %#v", got)
	}
}
