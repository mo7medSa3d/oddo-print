package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// capturingJobsServer stubs PATCH /api/agent/jobs and records every decoded
// status body it receives.
func capturingJobsServer(t *testing.T, bodies *[]map[string]interface{}) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/jobs" && r.Method == http.MethodPatch {
			var body map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			*bodies = append(*bodies, body)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
			return
		}
		http.NotFound(w, r)
	}))
}

func newCapturingAgent(t *testing.T, bodies *[]map[string]interface{}) *Agent {
	t.Helper()
	server := capturingJobsServer(t, bodies)
	t.Cleanup(server.Close)
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		if err := ag.Close(); err != nil {
			t.Logf("Agent.Close() error: %v", err)
		}
	})
	return ag
}

// The spooler evidence contract: a reported platform job ID must travel in
// the PATCH body the Gateway persists; an empty one must be omitted (older
// Gateways ignore unknown fields, and absent beats null).
func TestUpdateJobStatusSendsSpoolerJobID(t *testing.T) {
	var bodies []map[string]interface{}
	ag := newCapturingAgent(t, &bodies)
	if err := ag.updateJobStatus(context.Background(), "job_spool_1", "success", "", "claim-1", "456"); err != nil {
		t.Fatalf("updateJobStatus: %v", err)
	}
	if len(bodies) != 1 {
		t.Fatalf("expected 1 status report, got %d", len(bodies))
	}
	if got, _ := bodies[0]["spoolerJobId"].(string); got != "456" {
		t.Fatalf("PATCH body must carry spoolerJobId=456, got %v", bodies[0]["spoolerJobId"])
	}
}

func TestUpdateJobStatusOmitsEmptySpoolerJobID(t *testing.T) {
	var bodies []map[string]interface{}
	ag := newCapturingAgent(t, &bodies)
	if err := ag.updateJobStatus(context.Background(), "job_spool_2", "success", "", "claim-2", ""); err != nil {
		t.Fatalf("updateJobStatus: %v", err)
	}
	if len(bodies) != 1 {
		t.Fatalf("expected 1 status report, got %d", len(bodies))
	}
	if _, ok := bodies[0]["spoolerJobId"]; ok {
		t.Fatalf("empty spooler job ID must be omitted, got %v", bodies[0]["spoolerJobId"])
	}
}

// Dispatch-side linkage: a backend that reports an ID surfaces it through
// the same helper the success path uses.
func TestDispatchReadsSpoolerJobIDOfPrinter(t *testing.T) {
	p := &fakePrinter{}
	if got := printer.SpoolerJobIDOf(p); got != "" {
		t.Fatalf("plain fake backend must yield no spooler job ID, got %q", got)
	}
}
