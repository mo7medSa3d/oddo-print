package agent

import (
	"path/filepath"
	"testing"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/printer"
)

// TestHeartbeatPrinterStatusEmitsGatewayClassEnums pins the fix for the defect
// found in the live Gateway<->Agent run: every heartbeat was rejected with
//   {"skippedPrinters":[{"reason":"invalid_device_class_or_printer_type"}]}
// because the payload put the printer class ("physical") into the deviceClass
// field. The Gateway validates printerType and deviceClass against two
// different enums and drops the whole entry when either is out of range.
//
// The enums below are copied from src/lib/printer-model.ts; if the Gateway's
// vocabulary changes, this test must change with it.
func TestHeartbeatPrinterStatusEmitsGatewayClassEnums(t *testing.T) {
	gatewayPrinterTypes := map[string]bool{"physical": true, "virtual": true, "redirected": true}
	gatewayDeviceClasses := map[string]bool{
		"thermal": true, "laser": true, "inkjet": true, "label": true, "other": true, "unknown": true,
	}

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_device_class"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = "http://127.0.0.1:1"
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()

	// Every value an operator could realistically put in printer_type, plus the
	// mixed-case and empty forms.
	declared := []string{"physical", "virtual", "redirected", "thermal", "laser", "inkjet", "label", "other", "unknown", "", "Physical", "Virtual", "bogus", "  physical  "}

	ag.printers = make(map[string]printer.Printer, len(declared))
	ag.printerConfigs = make(map[string]config.PrinterConfig, len(declared))
	ids := make([]string, 0, len(declared))
	for i, pt := range declared {
		id := "printer-" + formatTestIndex(i)
		ids = append(ids, id)
		ag.printers[id] = &fakePrinter{}
		ag.printerConfigs[id] = config.PrinterConfig{
			ID: id, Name: id, Type: "network", Endpoint: "127.0.0.1:9100",
			Protocol: "raw", ConnectionType: "network", PrinterType: pt,
		}
	}

	payload := ag.printerStatusPayload()
	if len(payload) != len(declared) {
		t.Fatalf("expected %d entries, got %d", len(declared), len(payload))
	}

	byID := make(map[string]map[string]interface{}, len(payload))
	for _, entry := range payload {
		id, _ := entry["id"].(string)
		byID[id] = entry
	}

	for i, pt := range declared {
		entry := byID[ids[i]]
		if entry == nil {
			t.Fatalf("printer_type=%q: entry %q missing from payload", pt, ids[i])
		}
		printerType, _ := entry["printerType"].(string)
		deviceClass, _ := entry["deviceClass"].(string)

		if !gatewayPrinterTypes[printerType] {
			t.Errorf("printer_type=%q emitted invalid printerType %q (Gateway PRINTER_TYPES = physical|virtual|redirected)", pt, printerType)
		}
		if !gatewayDeviceClasses[deviceClass] {
			t.Errorf("printer_type=%q emitted invalid deviceClass %q (Gateway DEVICE_CLASSES = thermal|laser|inkjet|label|other|unknown) — this is the payload the Gateway rejects", pt, deviceClass)
		}
	}

	// The value that regressed: a plain physical printer must not report
	// "physical" as its device class.
	if entry := byID[ids[0]]; entry["deviceClass"] != "unknown" || entry["printerType"] != "physical" {
		t.Errorf("printer_type=physical => printerType=%v deviceClass=%v, want physical/unknown", entry["printerType"], entry["deviceClass"])
	}
	// A legacy config that put a real device class in printer_type keeps
	// reporting it (behaviour preserved).
	if entry := byID[ids[3]]; entry["deviceClass"] != "thermal" || entry["printerType"] != "physical" {
		t.Errorf("printer_type=thermal => printerType=%v deviceClass=%v, want physical/thermal", entry["printerType"], entry["deviceClass"])
	}
	// A virtual queue keeps its virtual printer type and reports an accepted
	// device class.
	if entry := byID[ids[1]]; entry["printerType"] != "virtual" || entry["deviceClass"] != "unknown" {
		t.Errorf("printer_type=virtual => printerType=%v deviceClass=%v, want virtual/unknown", entry["printerType"], entry["deviceClass"])
	}
	// Mixed case is normalized instead of being dropped (the old code compared
	// the raw value, so "Virtual" was reported as a physical printer with the
	// device class "Virtual" and was rejected outright).
	if entry := byID[ids[11]]; entry["printerType"] != "virtual" || entry["deviceClass"] != "unknown" {
		t.Errorf("printer_type=Virtual => printerType=%v deviceClass=%v, want virtual/unknown", entry["printerType"], entry["deviceClass"])
	}
	// redirected is a printer class, not a device class: preserve it as
	// redirected instead of silently converting it into a physical printer.
	if entry := byID[ids[2]]; entry["printerType"] != "redirected" || entry["deviceClass"] != "unknown" {
		t.Errorf("printer_type=redirected => printerType=%v deviceClass=%v, want redirected/unknown", entry["printerType"], entry["deviceClass"])
	}
}

func TestNormalizeDeviceClassFailsClosed(t *testing.T) {
	cases := map[string]string{
		"thermal": "thermal", "LASER": "laser", " inkjet ": "inkjet",
		"label": "label", "other": "other", "unknown": "unknown",
		"physical": "unknown", "virtual": "unknown", "redirected": "unknown",
		"": "unknown", "bogus": "unknown",
	}
	for in, want := range cases {
		if got := normalizeDeviceClass(in); got != want {
			t.Errorf("normalizeDeviceClass(%q) = %q, want %q", in, got, want)
		}
	}
}


func TestNormalizePrinterTypePreservesGatewayClasses(t *testing.T) {
	cases := map[string]string{
		"physical": "physical", "Physical": "physical", " thermal ": "physical",
		"virtual": "virtual", "Virtual": "virtual",
		"redirected": "redirected", " Redirected ": "redirected",
		"": "physical", "bogus": "physical",
	}
	for in, want := range cases {
		if got := normalizePrinterType(in); got != want {
			t.Errorf("normalizePrinterType(%q) = %q, want %q", in, got, want)
		}
	}
}
