package main

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestDiagnosticInventoryCountsRegistryOnlyAgent(t *testing.T) {
	registryPath := filepath.Join(t.TempDir(), "printers.json")
	row := printer.DeviceInfo{
		ID: "spooler-1", Name: "Office", ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: "Office", Endpoint: "Office", Status: "unknown", Enabled: true,
		Capabilities: map[string]interface{}{"registration_source": "manual"},
	}
	if err := printer.SaveRegistry(registryPath, []printer.DeviceInfo{row}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}
	cfg := &config.Config{}
	report := DiagnosticReport{Errors: []string{}}
	populateDiagnosticInventoryCounts(&report, cfg, registryPath, []printer.DeviceInfo{row})
	if report.Agent.ConfiguredPrinterCount != 0 {
		t.Fatalf("configured count=%d want 0", report.Agent.ConfiguredPrinterCount)
	}
	if report.Agent.RegistryPrinterCount != 1 || report.Agent.PrinterCount != 1 || report.Agent.RuntimeCapableCount != 1 {
		t.Fatalf("diagnostic counts=%+v", report.Agent)
	}
}
