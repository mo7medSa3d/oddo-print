package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type recordingGateway struct {
	mu                  sync.Mutex
	updates             []statusUpdate
	failTerminalOnce    bool
	terminalFailureUsed bool
	server              *httptest.Server
}

func (g *recordingGateway) Updates() []statusUpdate {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]statusUpdate, len(g.updates))
	copy(out, g.updates)
	return out
}

func newRecordingGateway(t *testing.T) *recordingGateway {
	t.Helper()
	g := &recordingGateway{}
	mux := http.NewServeMux()
	ackHandler := func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch, http.MethodPost:
			var body statusUpdate
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			g.mu.Lock()
			g.updates = append(g.updates, body)
			failTerminal := g.failTerminalOnce && !g.terminalFailureUsed && (body.Status == "success" || body.Status == "failed")
			if failTerminal {
				g.terminalFailureUsed = true
			}
			g.mu.Unlock()
			if failTerminal {
				http.Error(w, "gateway response lost after terminal acceptance window", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body.Status})
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
	mux.HandleFunc("/api/agent/jobs", ackHandler)
	mux.HandleFunc("/api/agent/ack", ackHandler)
	mux.HandleFunc("/api/agent/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	})
	g.server = httptest.NewServer(mux)
	t.Cleanup(g.server.Close)
	return g
}

func newAgentAgainst(t *testing.T, serverURL, printerID string, p printer.Printer) *Agent {
	t.Helper()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = serverURL
	no := false
	cfg.Agent.ReprintAfterCrash = &no
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		_ = ag.Close()
	})
	enabled := true
	ag.addPrinter(printerID, p, config.PrinterConfig{ID: printerID, Name: printerID, Type: "network", Endpoint: "10.0.0.20:9100", Protocol: "raw", Enabled: &enabled})
	return ag
}

// Full-module regression: actual processJob -> SQLite terminal outbox -> HTTP
// status payload. Unlike the portable projection this requires locked project
// dependencies, and must not be counted as executed by the isolated harness.
func TestProcessJobDoesNotAttributePreviousSpoolerIdentity(t *testing.T) {
	for _, mode := range []string{"pre-allocation-failure", "current-allocation-failure"} {
		t.Run(mode, func(t *testing.T) {
			gw := newRecordingGateway(t)
			gw.failTerminalOnce = true
			expected := ""
			if mode == "current-allocation-failure" {
				expected = "852"
			}
			p := &attemptEvidencePrinter{run: func(ctx context.Context) error {
				if expected != "" {
					printer.RecordSpoolerJobID(ctx, 852)
				}
				return errors.New("native transport refusal")
			}}
			ag := newAgentAgainst(t, gw.server.URL, "p1", p)
			id := "job-attempt-" + mode
			ag.processJob(context.Background(), map[string]interface{}{
				"id": id, "agentId": "agt_test", "printerId": "p1", "status": "claimed",
				"payload": makeJobPayload(id), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339), "claimToken": "claim-" + id, "bindingDigest": testDefaultPrinterBinding(),
			})
			ag.waitForJobs()
			reports, err := ag.queue.PendingTerminalReports(8)
			if err != nil || len(reports) != 1 || reports[0].Status != "failed" || reports[0].SpoolerJobID != expected {
				t.Fatalf("terminal outbox has wrong attempt identity: %+v %v", reports, err)
			}
			found := false
			for _, update := range gw.Updates() {
				if update.JobID == id && update.Status == "failed" {
					found = true
					if update.SpoolerJobID != expected {
						t.Fatalf("HTTP status carries wrong attempt evidence: %+v", update)
					}
				}
			}
			if !found {
				t.Fatal("missing terminal HTTP status")
			}
		})
	}
}
