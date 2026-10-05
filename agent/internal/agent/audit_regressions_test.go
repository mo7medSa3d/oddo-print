package agent

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/queue"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestAuditHeartbeatDisplayNameFitsGatewayWithoutChangingSpoolerIdentity(t *testing.T) {
	fullName := strings.Repeat("\U0001f5a8", 70)
	name := heartbeatPrinterName(fullName, "printer")
	if len(utf16.Encode([]rune(name))) != 100 || strings.ContainsRune(name, '\ufffd') {
		t.Fatalf("heartbeat name must fit 100 UTF-16 units intact: %q", name)
	}
	cfg := endpointToConfig(config.PrinterConfig{Type: "spooler", SpoolerName: fullName, Protocol: "spooler"})
	if cfg["spooler_name"] != fullName {
		t.Fatal("display truncation must not alter the spooler queue identity")
	}
	if heartbeatPrinterName("  ", "printer") != "printer" {
		t.Fatal("empty display name must remain valid at the Gateway")
	}
}

func TestAuditDiscoveryPayloadOmitsAbsentOptionalMetadata(t *testing.T) {
	for _, di := range []printer.DeviceInfo{
		{ID: "spooler", Name: "Receipt", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Receipt"},
		{ID: "candidate", Name: "Candidate", ConnectionType: "network"},
	} {
		payload := discoveryDevicePayload("agent", di)
		for _, key := range []string{"port", "manufacturer", "capabilities", "ipAddress", "uri"} {
			if _, ok := payload[key]; ok {
				t.Errorf("absent optional field %s was sent: %#v", key, payload)
			}
		}
		if payload["protocol"] == "" {
			t.Fatal("protocol must not be empty")
		}
		encoded, err := json.Marshal(payload)
		if err != nil || strings.Contains(string(encoded), "null") {
			t.Fatalf("unexpected null metadata: %s %v", encoded, err)
		}
	}
}

func TestAuditUSBHeartbeatUsesNumericIdentifiers(t *testing.T) {
	cfg := endpointToConfig(config.PrinterConfig{Type: "usb", Protocol: "raw", Endpoint: `\\?\usb#printer`, USBVID: "04b8", USBPID: "0x0202"})
	if cfg["vid"] != 1208 || cfg["pid"] != 514 {
		t.Fatalf("Gateway requires numeric USB IDs: %#v", cfg)
	}
}

func TestAuditBusyDiscoveryPollDoesNotCancelOwner(t *testing.T) {
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
			w.WriteHeader(204)
			return
		}
		_, _ = w.Write([]byte(`[{"id":"running-session"}]`))
	}))
	defer server.Close()
	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	a := &Agent{cfg: cfg, client: server.Client(), discoverySem: make(chan struct{}, 1)}
	a.discoverySem <- struct{}{}
	a.pollDiscovery(context.Background())
	if posts != 0 {
		t.Fatal("busy polling must not cancel the owner's active scan")
	}
	if len(a.discoverySem) != 1 {
		t.Fatal("poll stole the worker's semaphore ownership")
	}
}

func TestAuditDiscoveryErrorsAreBoundedAndEmptyDevicesAreArray(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if devices, ok := body["devices"].([]interface{}); !ok || len(devices) != 0 {
			t.Errorf("devices must be []: %#v", body)
		}
		diagnostics, ok := body["errors"].([]interface{})
		if !ok || len(diagnostics) != 64 {
			t.Errorf("bounded diagnostics missing: %#v", body)
			return
		}
		if len(diagnostics[0].(string)) != 2048 {
			t.Error("message bound not enforced")
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	a := &Agent{cfg: cfg, client: server.Client()}
	diagnostics := make([]string, 65)
	for i := range diagnostics {
		diagnostics[i] = strings.Repeat("x", 2050)
	}
	a.reportDiscoveryResult(context.Background(), "session", "failed", nil, diagnostics)
}

func TestAuditIPPPortAloneIsNotVerification(t *testing.T) {
	di := printer.DeviceInfo{Protocol: "ipp", ConnectionType: "ipp"}
	if discoveryVerification(di) != "candidate" {
		t.Fatal("open TCP port does not prove an IPP printer")
	}
	di.Capabilities = map[string]interface{}{"ipp_verified": true}
	if discoveryVerification(di) != "verified" {
		t.Fatal("successful IPP attributes should count as protocol evidence")
	}
}

func TestAuditPersistenceFailureRetainsObservedHardware(t *testing.T) {
	a := &Agent{registryPath: ""}
	original := printer.DeviceInfo{ID: "observed", Name: "Receipt", ConnectionType: "network", Protocol: "raw", Endpoint: "127.0.0.1:9100", Capabilities: map[string]interface{}{"discovered_via": "snmp"}}
	got, err := a.persistDiscoveredPrinters([]printer.DeviceInfo{original})
	if err == nil {
		t.Fatal("expected persistence failure for missing path")
	}
	if len(got) != 1 || got[0].ID != original.ID || got[0].Endpoint != original.Endpoint {
		t.Fatalf("observation discarded: %+v", got)
	}
	if got[0].Capabilities["registry_persistence_error"] == nil {
		t.Fatal("inventory omitted persistence diagnostic")
	}
	if original.Capabilities["registry_persistence_error"] != nil {
		t.Fatal("mutated caller's capability map")
	}
}

func TestAuditTerminalOutboxNeverUsesNewLiveClaim(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["claimToken"] != "old-token" {
			t.Errorf("old outcome reported against replacement claim: %#v", body)
		}
		http.Error(w, "stale", http.StatusConflict)
	}))
	defer server.Close()
	q, err := queue.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	a := &Agent{cfg: cfg, client: server.Client(), queue: q, inFlightTokens: map[string]string{"job": "new-token"}}
	if err := a.updateJobStatus(context.Background(), "job", "failed", "old attempt", "old-token", ""); !errors.Is(err, ErrStaleClaim) {
		t.Fatalf("wanted stale rejection, got %v", err)
	}
}

func TestAuditLegacyDisabledPrinterCannotBeRediscoveredIntoRuntime(t *testing.T) {
	disabled := false
	cfg := &config.Config{}
	cfg.Printers = []config.PrinterConfig{{ID: "disabled", Enabled: &disabled}}
	a := &Agent{cfg: cfg, printers: map[string]printer.Printer{}, printerConfigs: map[string]config.PrinterConfig{}, gatewayOwned: map[string]struct{}{}}
	pc := config.PrinterConfig{ID: "disabled", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "192.168.1.10:9100"}
	backend, err := printer.New(pc)
	if err != nil {
		t.Fatal(err)
	}
	if a.addPrinter(pc.ID, backend, pc) {
		t.Fatal("rediscovery enabled explicitly disabled YAML printer")
	}
	if _, exists := a.getPrinter(pc.ID); exists {
		t.Fatal("disabled printer is routable")
	}
	if len(a.printerStatusPayload()) != 0 {
		t.Fatal("disabled printer is inventoried as active")
	}
	pc.ID = "enabled-by-default"
	if !a.addPrinter(pc.ID, backend, pc) {
		t.Fatal("omitted enabled flag no longer defaults to enabled")
	}
}

func TestAuditConfirmedRegistryAbsenceRemovesRuntimeBackend(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	const id = "removed-spooler"
	a.printers[id] = &fakePrinter{status: "online"}
	a.printerConfigs[id] = config.PrinterConfig{ID: id, Name: "Removed Queue", Type: "spooler", Protocol: "spooler", SpoolerName: "Removed Queue"}
	a.registryOwned[id] = struct{}{}

	a.reconcileRegistryPrinters(nil)

	if _, ok := a.getPrinter(id); ok {
		t.Fatal("confirmed registry absence left stale runtime backend executable")
	}
	a.printersMu.RLock()
	_, stillConfigured := a.printerConfigs[id]
	_, stillOwned := a.registryOwned[id]
	a.printersMu.RUnlock()
	if stillConfigured || stillOwned {
		t.Fatalf("confirmed absence retained runtime ownership: configured=%v owned=%v", stillConfigured, stillOwned)
	}
}
