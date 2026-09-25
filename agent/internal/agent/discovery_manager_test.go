package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yasser-agent/agent/internal/config"

	"github.com/yasser-agent/agent/internal/printer"
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
