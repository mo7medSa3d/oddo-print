package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// A WebSocket reader must not wait for Gateway HTTP I/O just because SQLite
// failed after the physical attempt. Test the production dispatch method,
// including a Gateway that accepts the PATCH but stalls its response body.
func TestTerminalDuplicateDoesNotBlockReaderOrAdoptNewClaim(t *testing.T) {
	entered := make(chan string, 4)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/api/agent/jobs" {
			http.NotFound(w, r)
			return
		}
		var request struct {
			JobID      string `json:"jobId"`
			Status     string `json:"status"`
			ClaimToken string `json:"claimToken"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		entered <- request.ClaimToken
		<-release
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": request.Status})
	}))
	defer server.Close()

	ag := newTestAgent(t, "p1", &fakePrinter{})
	ag.cfg.Server.URL = server.URL
	ag.inFlightMu.Lock()
	ag.terminalExecution["already_printed"] = terminalExecutionResult{
		status: "success", claimToken: "original-physical-claim", spoolerJobID: "spool-4",
	}
	ag.inFlightMu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	ag.launchTracked(func() { ag.runTerminalReportWorker(ctx) })
	defer func() {
		cancel()
		once.Do(func() { close(release) })
		ag.runtimeWG.Wait()
	}()

	job := dispatchTestJob("already_printed", "p1")
	job["claimToken"] = "new-claimed-token"
	firstReturned := make(chan bool, 1)
	go func() { firstReturned <- ag.dispatchJobWithContexts(ctx, ctx, job) }()
	select {
	case admitted := <-firstReturned:
		if admitted {
			t.Fatal("terminal duplicate must not dispatch to printer")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("WebSocket reader blocked by terminal re-report HTTP")
	}

	select {
	case token := <-entered:
		if token != "original-physical-claim" {
			t.Fatalf("physical outcome re-report adopted an unrelated claim token: %q", token)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("background terminal report never reached the Gateway")
	}

	for i := 0; i < 10; i++ {
		if ag.dispatchJobWithContexts(ctx, ctx, job) {
			t.Fatal("terminal duplicate was re-admitted while HTTP stalled")
		}
	}
	select {
	case token := <-entered:
		t.Fatalf("duplicate reports were not coalesced; second token %q", token)
	default:
	}
	if ag.inFlightCount() != 0 {
		t.Fatal("terminal duplicates must never enter physical executor")
	}
	once.Do(func() { close(release) })
}

// Saturation is bounded in both channel and pending-index memory. A full
// reporting queue may lose a best-effort callback, but it must *not* release
// the original physical fence or start a new physical attempt.
func TestTerminalDuplicateReportingQueueIsBounded(t *testing.T) {
	ag := newTestAgent(t, "p1", &fakePrinter{})
	ctx := context.Background()
	for i := 0; i < maxTerminalReportQueue+7; i++ {
		job := dispatchTestJob("terminal-bounded-"+stringID(i), "p1")
		id := job["id"].(string)
		ag.inFlightMu.Lock()
		ag.terminalExecution[id] = terminalExecutionResult{status: "failed", errMsg: "UNKNOWN_PARTIAL_DELIVERY", claimToken: "old-" + id}
		ag.inFlightMu.Unlock()
		if ag.dispatchJobWithContexts(ctx, ctx, job) {
			t.Fatalf("physically completed job %s was admitted to printer", id)
		}
	}
	if got := len(ag.terminalReportQueue); got != maxTerminalReportQueue {
		t.Fatalf("bounded reporting queue has %d items, want %d", got, maxTerminalReportQueue)
	}
	if got := len(ag.terminalReportPending); got != maxTerminalReportQueue {
		t.Fatalf("pending index has %d items, want %d", got, maxTerminalReportQueue)
	}
	if ag.inFlightCount() != 0 {
		t.Fatal("terminal outcome fence did not prevent physical dispatch when queue saturated")
	}
}

func TestCanceledTerminalReportSessionCannotQueueHTTP(t *testing.T) {
	ag := newTestAgent(t, "p1", &fakePrinter{})
	ag.inFlightMu.Lock()
	ag.terminalExecution["terminal-disconnect"] = terminalExecutionResult{status: "success", claimToken: "old-claim"}
	ag.inFlightMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if ag.dispatchJobWithContexts(context.Background(), ctx, dispatchTestJob("terminal-disconnect", "p1")) {
		t.Fatal("terminal result was physically readmitted after session canceled")
	}
	if len(ag.terminalReportQueue) != 0 {
		t.Fatal("canceled session queued a terminal HTTP request")
	}
}

func stringID(n int) string { return fmt.Sprintf("%d", n) }
