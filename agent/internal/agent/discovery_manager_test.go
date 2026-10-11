package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"

	"github.com/yaseir-agent/agent/internal/printer"
)

func TestDiscoveryVerificationDoesNotTrustWSDAsPrintVerification(t *testing.T) {
	di := printer.DeviceInfo{
		Protocol: "", ConnectionType: "network",
		Capabilities: map[string]interface{}{"wsd_verified": true},
	}
	if got := discoveryVerification(di); got != "candidate" {
		t.Fatalf("stale WSD verification must remain candidate, got %q", got)
	}
}

func TestDiscoveryDeviceIDIsDeterministicAndAgentScoped(t *testing.T) {
	first := discoveryDeviceID("agent-a", "printer_net_1234")
	second := discoveryDeviceID("agent-a", "printer_net_1234")
	third := discoveryDeviceID("agent-b", "printer_net_1234")
	if first != second {
		t.Fatalf("expected deterministic discovery ID, got %q and %q", first, second)
	}
	if first == third {
		t.Fatalf("discovery IDs must be agent-scoped, got shared ID %q", first)
	}
}

func TestReportDiscoveryResultRetriesTransientGatewayFailures(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	cfg.Agent.ID = "agent-retry"
	cfg.Agent.Secret = "secret"
	a := &Agent{cfg: cfg, client: server.Client()}

	a.reportDiscoveryResult(context.Background(), "disc-retry", "completed", []map[string]interface{}{
		{"id": "dev_1", "stableId": "printer_net_1"},
	})
	if attempts != 3 {
		t.Fatalf("expected two transient failures followed by success, got %d attempts", attempts)
	}
}

func TestReportDiscoveryResultDoesNotRetryTerminalGatewayErrors(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusConflict)
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	cfg.Agent.ID = "agent-terminal"
	cfg.Agent.Secret = "secret"
	a := &Agent{cfg: cfg, client: server.Client()}

	a.reportDiscoveryResult(context.Background(), "disc-terminal", "completed", nil)
	if attempts != 1 {
		t.Fatalf("terminal 409 must not be retried, got %d attempts", attempts)
	}
}

func TestLoadDiscoverySessionByIDRejectsWrongTypedIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[{"id":123},{"id":null},{"id":"disc-ok"}]`))
	}))
	defer server.Close()

	session := loadDiscoverySessionByID(context.Background(), func(ctx context.Context) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			return nil, err
		}
		return server.Client().Do(req)
	}, "disc-ok")
	if session == nil {
		t.Fatal("valid string discovery id was lost after malformed entries")
	}

	missing := loadDiscoverySessionByID(context.Background(), func(ctx context.Context) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			return nil, err
		}
		return server.Client().Do(req)
	}, "not-present")
	if missing != nil {
		t.Fatalf("unexpected session for missing id: %#v", missing)
	}
}

func TestDiscoverySessionTimeoutUsesGatewayValue(t *testing.T) {
	if got := discoverySessionTimeout(map[string]interface{}{}); got != defaultDiscoveryTimeout {
		t.Fatalf("missing timeoutMs = %s, want %s", got, defaultDiscoveryTimeout)
	}
	if got := discoverySessionTimeout(map[string]interface{}{
		"config": map[string]interface{}{"timeoutMs": float64(1500)},
	}); got != 1500*time.Millisecond {
		t.Fatalf("Gateway timeoutMs = %s, want 1.5s", got)
	}
	if got := discoverySessionTimeout(map[string]interface{}{
		"config": map[string]interface{}{"timeoutMs": float64(100)},
	}); got != minDiscoveryTimeout {
		t.Fatalf("too-small timeoutMs = %s, want minimum %s", got, minDiscoveryTimeout)
	}
	if got := discoverySessionTimeout(map[string]interface{}{
		"config": map[string]interface{}{"timeoutMs": float64(60000)},
	}); got != maxDiscoveryTimeout {
		t.Fatalf("too-large timeoutMs = %s, want maximum %s", got, maxDiscoveryTimeout)
	}
}

func TestLoadDiscoverySessionByID(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusOK,
		Body:       http.NoBody,
	}
	_ = response
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"id":"disc-1","config":{"timeoutMs":1500}},{"id":"disc-2","config":{"timeoutMs":5000}}]`))
	}))
	defer server.Close()

	client := server.Client()
	session := loadDiscoverySessionByID(context.Background(), func(ctx context.Context) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			return nil, err
		}
		return client.Do(req)
	}, "disc-2")
	if got := discoverySessionTimeout(session); got != 5*time.Second {
		t.Fatalf("loaded session timeout = %s, want 5s", got)
	}

	missing := loadDiscoverySessionByID(context.Background(), func(ctx context.Context) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			return nil, err
		}
		return client.Do(req)
	}, "missing")
	if missing != nil {
		t.Fatalf("missing discovery session should return nil, got %#v", missing)
	}
}

func TestDiscoveryVerificationDoesNotPromoteNonRuntimeNetworkEvidence(t *testing.T) {
	di := printer.DeviceInfo{
		ID:             "tcp-candidate",
		Name:           "Open 9100",
		ConnectionType: "network",
		Protocol:       "unknown",
		Capabilities: map[string]interface{}{
			"discovered_via": "tcp_port_scan",
			"verification":   "print_endpoint_verified",
			"snmp_verified":  true,
		},
	}
	if got := discoveryVerification(di); got != "candidate" {
		t.Fatalf("non-runtime network evidence must remain candidate, got %q", got)
	}
}

// Every batch must satisfy the Gateway's admission limits, not merely the
// Agent's larger LAN inventory limits. A single scan can observe >1000 hosts.
func TestBuildDiscoveryReportPayloadsBoundedAcrossLargeInventory(t *testing.T) {
	devices := make([]map[string]interface{}, 1091)
	for i := range devices {
		devices[i] = map[string]interface{}{
			"id":       fmt.Sprintf("dev_%06d", i),
			"protocol": "ipp", "deviceName": "Office printer",
			"rawMetadata": map[string]interface{}{"reason": "reachable"},
		}
	}
	pages, err := buildDiscoveryReportPayloads("disc-paged", "completed", devices, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) < 5 {
		t.Fatalf("1091 observations should require at least 5 pages, got %d", len(pages))
	}
	observed := 0
	for i, body := range pages {
		if len(body) > discoveryReportBodyLimit {
			t.Fatalf("page %d over Gateway byte ceiling", i)
		}
		var decoded struct {
			ChunkIndex      int               `json:"chunkIndex"`
			ChunkCount      int               `json:"chunkCount"`
			Status          string            `json:"status"`
			TotalCandidates int               `json:"totalCandidates"`
			Devices         []json.RawMessage `json:"devices"`
		}
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatalf("decode page %d: %v", i, err)
		}
		if decoded.ChunkIndex != i || decoded.ChunkCount != len(pages) || decoded.TotalCandidates != len(devices) {
			t.Fatalf("page %d has inconsistent paging metadata: %+v", i, decoded)
		}
		if len(decoded.Devices) > discoveryReportMaxDevices {
			t.Fatalf("page %d exceeds device limit", i)
		}
		if i+1 < len(pages) && decoded.Status != "running" {
			t.Fatalf("non-final page %d prematurely terminal: %q", i, decoded.Status)
		}
		if i+1 == len(pages) && decoded.Status != "completed" {
			t.Fatalf("final page missing completion: %q", decoded.Status)
		}
		observed += len(decoded.Devices)
	}
	if observed != len(devices) {
		t.Fatalf("lost observations: got %d of %d", observed, len(devices))
	}
}

func TestBuildDiscoveryReportPayloadsOversizeDeviceMarksPartial(t *testing.T) {
	devices := []map[string]interface{}{
		{"id": "valid"},
		{"id": "oversized", "rawMetadata": map[string]interface{}{"value": strings.Repeat("x", discoveryReportDeviceBudget+1)}},
	}
	pages, err := buildDiscoveryReportPayloads("disc-oversize", "completed", devices, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 {
		t.Fatalf("expected one bounded batch, got %d", len(pages))
	}
	var decoded struct {
		Status  string                   `json:"status"`
		Devices []map[string]interface{} `json:"devices"`
		Errors  []string                 `json:"errors"`
	}
	if err := json.Unmarshal(pages[0], &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Status != "partial" || len(decoded.Devices) != 1 || len(decoded.Errors) == 0 {
		t.Fatalf("oversized device should be skipped with partial status: %+v", decoded)
	}
}

func TestReportDiscoveryResultResendsSamePageAfterLostAcknowledgment(t *testing.T) {
	attemptsByIndex := map[int]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var decoded struct {
			ChunkIndex int `json:"chunkIndex"`
			ChunkCount int `json:"chunkCount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&decoded); err != nil {
			t.Errorf("request payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if decoded.ChunkCount != 2 {
			t.Errorf("expected 2 pages, got %d", decoded.ChunkCount)
		}
		attemptsByIndex[decoded.ChunkIndex]++
		if decoded.ChunkIndex == 0 && attemptsByIndex[0] == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	cfg := &config.Config{}
	cfg.Server.URL = server.URL
	cfg.Agent.ID = "agent-paged"
	cfg.Agent.Secret = "secret"
	a := &Agent{cfg: cfg, client: server.Client()}
	devices := make([]map[string]interface{}, 251)
	for i := range devices {
		devices[i] = map[string]interface{}{"id": fmt.Sprintf("dev_%03d", i)}
	}
	a.reportDiscoveryResult(context.Background(), "disc-resumable", "completed", devices)
	if attemptsByIndex[0] != 2 || attemptsByIndex[1] != 1 {
		t.Fatalf("expected retry of only the failed page; got attempts %+v", attemptsByIndex)
	}
}
