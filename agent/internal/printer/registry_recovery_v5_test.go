package printer

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoveryCannotRebuildUnreadableRegistryAndForgetEstablishedDecision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := DeviceInfo{ID: "established", Name: "Invoice", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://10.0.0.10/ipp/print", Enabled: false,
		Capabilities: map[string]interface{}{"registration_source": "manual", "ipp_printer_uuid": "urn:uuid:11111111-1111-4111-8111-111111111111"}}
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	original = append(original, []byte("\n{interrupted write")...)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	observation := prior
	observation.Enabled = true
	observation.Capabilities = map[string]interface{}{"registration_source": "discovery", "ipp_verified": true, "ipp_printer_uuid": "urn:uuid:22222222-2222-4222-8222-222222222222"}
	for attempt := 0; attempt < 2; attempt++ {
		if accepted, err := UpsertRegistry(path, []DeviceInfo{observation}); !errors.Is(err, ErrRegistryUntrusted) || len(accepted) != 0 {
			t.Fatalf("discovery rebuilt unreadable authority and lost disablement/UUID: accepted=%+v error=%v", accepted, err)
		}
		current, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(current, original) {
			t.Fatalf("automatic discovery moved or rewrote unreadable authority: error=%v", err)
		}
	}
}

func TestDiscoveryCanCreateMissingRegistry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	observation := DeviceInfo{ID: "new_printer", Name: "Printer", ConnectionType: "spooler", Protocol: "spooler", Endpoint: "Queue", SpoolerName: "Queue", Enabled: true}
	if rows, err := UpsertRegistry(path, []DeviceInfo{observation}); err != nil || len(rows) != 1 || rows[0].ID != observation.ID {
		t.Fatalf("first-run discovery must still initialize a missing registry: rows=%+v error=%v", rows, err)
	}
}

func TestExistingRegistryRequiresAnInventoryArray(t *testing.T) {
	for _, content := range []string{"", " \n", "null", "{}"} {
		t.Run(content, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := UpsertRegistry(path, nil); !errors.Is(err, ErrRegistryUntrusted) {
				t.Fatalf("existing non-inventory registry %q was automatically reset", content)
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != content {
				t.Fatalf("existing non-inventory registry was rewritten: %q %v", got, err)
			}
		})
	}
}
