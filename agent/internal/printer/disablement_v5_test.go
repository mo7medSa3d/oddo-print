package printer

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestManualRegistrationChangesEnabledButRediscoveryCannot(t *testing.T) {
	for _, initiallyEnabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("initially-enabled-%v", initiallyEnabled), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			device := DeviceInfo{ID: "local", Name: "Receipt", ConnectionType: "network", PrinterType: "thermal", Protocol: "raw", Endpoint: "10.0.0.20:9100", Enabled: initiallyEnabled}
			if err := SaveRegistry(path, []DeviceInfo{device}); err != nil {
				t.Fatal(err)
			}
			device.Enabled = !initiallyEnabled
			if _, err := RegisterManual(path, device); err != nil {
				t.Fatal(err)
			}
			rows, err := LoadRegistryPrinters(path)
			if err != nil || len(rows) != 1 || rows[0].Enabled != device.Enabled {
				t.Fatalf("explicit operator enablement change was reported successful but not persisted: rows=%+v err=%v", rows, err)
			}
			device.Enabled = initiallyEnabled
			// A discovery capability string is data, never authorization to
			// change an operator's explicit decision.
			device.Capabilities = map[string]interface{}{"registration_source": "manual"}
			if _, err := UpsertRegistry(path, []DeviceInfo{device}); err != nil {
				t.Fatal(err)
			}
			rows, err = LoadRegistryPrinters(path)
			if err != nil || len(rows) != 1 || rows[0].Enabled == initiallyEnabled {
				t.Fatalf("rediscovery overrode operator enablement: rows=%+v err=%v", rows, err)
			}
			for _, aliasID := range []string{"", "new-alias"} {
				device.ID = aliasID
				if _, err := RegisterManual(path, device); err != nil {
					t.Fatal(err)
				}
				rows, err = LoadRegistryPrinters(path)
				if err != nil || len(rows) != 1 || rows[0].ID != "local" || rows[0].Enabled == initiallyEnabled {
					t.Fatalf("alias re-add changed an established ID's enablement: rows=%+v err=%v", rows, err)
				}
			}
		})
	}
}

func TestRegistryExplicitNullEnabledFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	original := []byte(`[{"id":"local","name":"Receipt","printerType":"thermal","connectionType":"network","protocol":"raw","endpoint":"10.0.0.20:9100","enabled":null}]`)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	rows, err := LoadRegistryPrinters(path)
	if !errors.Is(err, ErrRegistryUntrusted) || len(rows) != 0 {
		t.Fatalf("explicit null enablement became trusted policy: rows=%+v err=%v", rows, err)
	}
	current, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(original, current) {
		t.Fatalf("invalid operator authority was rewritten: %v", err)
	}
}

func TestLocalDiagnosticRespectsExplicitDisablement(t *testing.T) {
	for _, source := range []string{"registry", "yaml", "registry-with-enabled-yaml", "yaml-with-registry-alias"} {
		t.Run(source, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			cfg := &config.Config{}
			disabled := false
			pc := config.PrinterConfig{ID: "export", Name: "Disabled queue", Type: "spooler", Protocol: "spooler", SpoolerName: "Disabled Queue", Enabled: &disabled}
			device := DeviceInfo{ID: pc.ID, Name: pc.Name, ConnectionType: pc.Type, Protocol: pc.Protocol, SpoolerName: pc.SpoolerName, Enabled: false}
			id := pc.ID
			switch source {
			case "yaml":
				cfg.Printers = []config.PrinterConfig{pc}
			case "registry-with-enabled-yaml":
				pc.Enabled = nil
				cfg.Printers = []config.PrinterConfig{pc}
			case "yaml-with-registry-alias":
				cfg.Printers = []config.PrinterConfig{pc}
				device.ID, device.Enabled, id = "alias", true, "alias"
			}
			if source != "yaml" {
				if err := SaveRegistry(path, []DeviceInfo{device}); err != nil {
					t.Fatal(err)
				}
			}
			if err := TestPrinter(cfg, path, id); err == nil || !strings.Contains(err.Error(), "disabled") {
				t.Fatalf("diagnostic bypassed explicit local disablement: %v", err)
			}
		})
	}
}
