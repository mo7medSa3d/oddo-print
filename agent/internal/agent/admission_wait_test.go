package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestPrinterWaiterRequestsFreshAdmissionBeforeHardware(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	var secondAdmissions atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if r.Method != http.MethodPatch || json.NewDecoder(r.Body).Decode(&body) != nil {
			http.NotFound(w, r)
			return
		}
		if body["status"] == "printing" && body["jobId"] == "waiter" {
			secondAdmissions.Add(1)
			http.Error(w, "claim expired or printer disabled while waiting", http.StatusConflict)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
	}))
	defer srv.Close()
	cfg := &config.Config{}
	cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer ag.Close()
	p := &fakePrinter{blocked: make(chan struct{}), startedCh: make(chan string, 2)}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{"p1": {ID: "p1", Type: "network", Protocol: "raw", Endpoint: "127.0.0.1:9100"}}
	allowInjectedPrintersForTest(ag)
	ag.dispatchJob(context.Background(), dispatchTestJob("first", "p1"))
	select {
	case <-p.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("first print did not start")
	}
	// The alias names the same local backend and must share its mutex.
	ag.dispatchJob(context.Background(), dispatchTestJob("waiter", "p1~aaaaaaaa"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		count, err := ag.queue.CountByStatus("printing")
		if err != nil {
			t.Fatal(err)
		}
		// Only the first job may be in the physical-attempt phase.
		// A waiter must remain durable but provably not dispatched, so a
		// crash while the printer mutex is occupied cannot manufacture an
		// UNKNOWN physical outcome for the waiting job.
		_, waiterStatus, waiterFound, lookupErr := ag.queue.Get("waiter")
		if lookupErr != nil {
			t.Fatal(lookupErr)
		}
		if waiterFound {
			if count != 1 || waiterStatus != "queued" {
				t.Fatalf("waiting job is not a physical attempt: printing=%d waiter=%q", count, waiterStatus)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiter was not reserved")
		}
		time.Sleep(time.Millisecond)
	}
	if secondAdmissions.Load() != 0 {
		t.Fatal("waiter requested admission before the printer was free")
	}
	close(p.blocked)
	if !ag.waitForJobsFor(5 * time.Second) {
		t.Fatal("jobs did not drain")
	}
	if secondAdmissions.Load() != 1 {
		t.Fatal("waiter did not request fresh Gateway admission")
	}
	if p.Calls() != 1 {
		t.Fatalf("refused waiter reached hardware: %d calls", p.Calls())
	}
}

// The queued reservation has the original claim token. Its return to Gateway
// must be durable, fenced, and must not requeue a LIVE waiter.
func TestPreDispatchHandBackRetriesWithoutTouchingLiveJob(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/api/agent/jobs" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			JobID      string `json:"jobId"`
			Status     string `json:"status"`
			Reason     string `json:"reason"`
			ClaimToken string `json:"claimToken"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.JobID != "waiting" || body.Status != "queued" || body.ClaimToken != "original-claim" || body.Reason != "agent_shutting_down" {
			http.Error(w, "invalid fenced hand-back", http.StatusBadRequest)
			return
		}
		if attempts.Add(1) == 1 {
			http.Error(w, "transient Gateway outage", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": "queued"})
	}))
	defer srv.Close()
	cfg := &config.Config{}
	cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer ag.Close()
	if err := ag.queue.ReserveBeforeDispatch("waiting", "p1", []byte("receipt"), "original-claim"); err != nil {
		t.Fatal(err)
	}
	// Simulate the scheduler's active waiter reservation. A health tick is
	// forbidden from returning a job that is still waiting on a printer.
	ag.inFlightMu.Lock()
	ag.inFlight["waiting"] = struct{}{}
	ag.inFlightMu.Unlock()
	ag.reportPendingTerminalStatuses(context.Background())
	if got := attempts.Load(); got != 0 {
		t.Fatalf("live waiter was incorrectly returned to Gateway: %d", got)
	}
	ag.inFlightMu.Lock()
	delete(ag.inFlight, "waiting")
	ag.inFlightMu.Unlock()
	ag.reportPendingTerminalStatuses(context.Background())
	if attempts.Load() != 1 || ag.queue.ClaimTokenFor("waiting") != "original-claim" {
		t.Fatal("first failed hand-back must preserve original durable claim")
	}
	ag.reportPendingTerminalStatuses(context.Background())
	if attempts.Load() != 2 || ag.queue.ClaimTokenFor("waiting") != "" {
		t.Fatal("successful hand-back must clear original claim only after gateway ACK")
	}
}

// Exhausting the SQL scan limit with live waiters must not starve an abandoned
// pre-dispatch claim on every periodic sweep. Only idle claims are sent back.
func TestPreDispatchHandBackScansPastBusyWaiters(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	var returns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			JobID      string `json:"jobId"`
			ClaimToken string `json:"claimToken"`
			Status     string `json:"status"`
		}
		if r.Method != http.MethodPatch || json.NewDecoder(r.Body).Decode(&body) != nil ||
			body.JobID != "abandoned" || body.ClaimToken != "abandoned-claim" || body.Status != "queued" {
			http.Error(w, "unexpected or live job returned", http.StatusBadRequest)
			return
		}
		returns.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": "queued"})
	}))
	defer srv.Close()
	cfg := &config.Config{}
	cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	// The test deliberately inserts synthetic in-flight IDs without starting
	// real goroutines. Remove them before Agent.Close or Windows keeps the
	// SQLite ledger handle open and TempDir cleanup fails with sharing denied.
	defer func() {
		ag.inFlightMu.Lock()
		for _, id := range []string{"busy-a", "busy-b", "busy-c", "busy-d"} {
			delete(ag.inFlight, id)
		}
		ag.inFlightMu.Unlock()
		ag.Close()
	}()
	for _, id := range []string{"busy-a", "busy-b", "busy-c", "busy-d"} {
		if err := ag.queue.ReserveBeforeDispatch(id, "p1", []byte("receipt"), "live-"+id); err != nil {
			t.Fatal(err)
		}
		ag.inFlightMu.Lock()
		ag.inFlight[id] = struct{}{}
		ag.inFlightMu.Unlock()
	}
	// SQLite timestamps have second granularity; make the ordering
	// deterministic even when the test runner uses a slow filesystem.
	time.Sleep(1200 * time.Millisecond)
	if err := ag.queue.ReserveBeforeDispatch("abandoned", "p1", []byte("receipt"), "abandoned-claim"); err != nil {
		t.Fatal(err)
	}
	ag.reportPendingTerminalStatuses(context.Background())
	if got := returns.Load(); got != 1 {
		t.Fatalf("abandoned claim starved behind live waiters: %d returns", got)
	}
	if got := ag.queue.ClaimTokenFor("abandoned"); got != "" {
		t.Fatalf("acknowledged abandoned claim not cleared: %q", got)
	}
}
