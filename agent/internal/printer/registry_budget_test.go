package printer

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveRegistryRejectsOversizeWithoutReplacingValidState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	kept := DeviceInfo{ID: "kept", Name: "Office Printer", ConnectionType: "spooler",
		Protocol: "spooler", SpoolerName: "Office Printer", Endpoint: "Office Printer", Enabled: true}
	if err := SaveRegistry(path, []DeviceInfo{kept}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	oversized := kept
	oversized.Name = strings.Repeat("x", maxRegistryBytes)
	if err := SaveRegistry(path, []DeviceInfo{oversized}); err == nil {
		t.Fatal("SaveRegistry accepted data that its reader cannot load")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("rejected registry update changed durable state: err=%v", err)
	}
	rows, err := LoadRegistryPrinters(path)
	if err != nil || len(rows) != 1 || rows[0].ID != "kept" || rows[0].Name != "Office Printer" {
		t.Fatalf("previous registry did not survive rejected update: rows=%v err=%v", rows, err)
	}
}
