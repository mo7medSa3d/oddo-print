package agent

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type statusDetailPrinter struct{ fakePrinter }

func (p *statusDetailPrinter) StatusDetail() string { return "paused" }

// TestHeartbeatPrinterStatusEmitsGatewayClassEnums pins the fix for the defect
// found in the live Gateway<->Agent run: every heartbeat was rejected with
//
//	{"skippedPrinters":[{"reason":"invalid_device_class_or_printer_type"}]}
//
// because the payload put the printer class ("physical") into the deviceClass
// field. The Gateway validates printerType and deviceClass against two
// different enums and drops the whole entry when either is out of range.
//
// The enums below are copied from src/lib/printer-model.ts; if the Gateway's
// vocabulary changes, this test must change with it.
func TestHeartbeatPrinterStatusEmitsGatewayClassEnums(t *testing.T) {
	gatewayPrinterTypes := map[string]bool{"physical": true}
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
			ID:             id,
			Name:           id,
			Type:           "network",
			Endpoint:       "127.0.0.1:9100",
			Protocol:       "raw",
			ConnectionType: "network",
			PrinterType:    pt,
		}
	}

	payload := ag.printerStatusPayload()
	if len(payload) != len(declared)-3 {
		t.Fatalf("expected %d physical entries, got %d", len(declared)-3, len(payload))
	}

	byID := make(map[string]map[string]interface{}, len(payload))
	for _, entry := range payload {
		id, _ := entry["id"].(string)
		byID[id] = entry
	}

	for i, pt := range declared {
		entry := byID[ids[i]]
		if i == 1 || i == 2 || i == 11 {
			if entry != nil {
				t.Errorf("virtual/redirected %q leaked into heartbeat", pt)
			}
			continue
		}
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

func TestHeartbeatPublishesProtocolStatusDetailWithoutChangingHealth(t *testing.T) {
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_status_detail"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = "http://127.0.0.1:1"
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	p := &statusDetailPrinter{}
	p.status = "error"
	ag.printers = map[string]printer.Printer{"ipp-1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"ipp-1": {ID: "ipp-1", Name: "IPP", Type: "ipp", Protocol: "ipp", Endpoint: "http://127.0.0.1:631/ipp/print"},
	}
	payload := ag.printerStatusPayload()
	if len(payload) != 1 {
		t.Fatalf("payload len=%d want 1", len(payload))
	}
	if payload[0]["status"] != "error" {
		t.Fatalf("status=%v want error", payload[0]["status"])
	}
	caps, _ := payload[0]["capabilities"].(map[string]interface{})
	if caps["status_detail"] != "paused" {
		t.Fatalf("status_detail=%v want paused", caps["status_detail"])
	}
}
