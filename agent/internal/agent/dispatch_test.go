package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/printer"
)

// TestRedeliveryKeepsOriginalClaimTokenForReports proves the full loop of the
// WS-send/evidence-loss race on the agent side:
//
//  1. delivery #1 (token A) reaches the printer and parks mid-print;
//  2. the Gateway (after a lost delivered_at write + release) re-claims and
//     redelivers the SAME job under token B while A is still executing;
//  3. the duplicate must NOT cause a second physical write;
//  4. the in-flight execution must retain token A. A fresh token B belongs to
//     the Gateway's new claim and must never be adopted by the already-running
//     physical attempt; otherwise a stale attempt could report success as B.
func TestRedeliveryAdoptsLiveClaimTokenForReports(t *testing.T) {
	var mu sync.Mutex
	var patches []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/jobs" && r.Method == http.MethodPatch {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			patches = append(patches, body)
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer ag.Close()
	p := &fakePrinter{blocked: make(chan struct{}), startedCh: make(chan string, 1)}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{"p1": {ID: "p1", Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"}}

	first := dispatchTestJob("reclaim_token_race", "p1")
	first["claimToken"] = "tok-A"
	ag.dispatchJob(context.Background(), first)
	select {
	case <-p.startedCh:
	case <-time.After(10 * time.Second):
		t.Fatal("first print never reached the device")
	}
	allowInjectedPrintersForTest(ag)

	// The "printing" report happened under the live token at the time (A).
	mu.Lock()
	sawPrintingA := false
	for _, b := range patches {
		if b["status"] == "printing" && b["claimToken"] == "tok-A" {
			sawPrintingA = true
		}
	}
	mu.Unlock()
	if !sawPrintingA {
		t.Fatal("expected a printing report fenced with tok-A before redelivery")
	}

	second := dispatchTestJob("reclaim_token_race", "p1")
	second["claimToken"] = "tok-B"
	receivedBefore := ag.deliveryReceivedAt("reclaim_token_race")
	ag.dispatchJob(context.Background(), second)

	// A duplicate with a fresh claim token must not overwrite the active local
	// execution's token. The Gateway owns token B; this physical attempt owns A.
	pairs := ag.inFlightJobIDs(64)
	if len(pairs) != 1 || pairs[0]["jobId"] != "reclaim_token_race" || pairs[0]["claimToken"] != "tok-A" {
		t.Fatalf("duplicate delivery must retain the active claim token, got %v", pairs)
	}
	// The duplicate is rejected by the local in-flight fence, so it must not
	// refresh delivery metadata for the already-running attempt.
	if received := ag.deliveryReceivedAt("reclaim_token_race"); !received.Equal(receivedBefore) {
		t.Fatalf("duplicate delivery must not replace the active delivery timestamp (before=%v after=%v)", receivedBefore, received)
	}

	close(p.blocked)
	ag.waitForJobs()

	if got := p.callsByJob["reclaim_token_race"]; got != 1 {
		t.Fatalf("redelivered in-flight job must physically print exactly once, got %d", got)
	}
	mu.Lock()
	defer mu.Unlock()
	var successToken interface{}
	var sawSuccess bool
	for _, b := range patches {
		if b["jobId"] == "reclaim_token_race" && b["status"] == "success" {
			successToken = b["claimToken"]
			sawSuccess = true
		}
	}
	if !sawSuccess {
		t.Fatal("no terminal success report was sent")
	}
	if successToken != "tok-A" {
		t.Fatalf("terminal report must retain the original physical attempt token tok-A, got %v", successToken)
	}
}

func dispatchTestJob(id, printerID string) map[string]interface{} {
	return map[string]interface{}{
		"id":        id,
		"printerId": printerID,
		"payload":   makeJobPayload(id),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
}

// The gateway delivers the same job over WS and the poll fallback; while the
// first copy is still printing, the second delivery must be dropped instead
// of queueing another print.
//
// The first print is kept provably in-flight when the duplicate arrives:
// fakePrinter parks on `blocked` once it has signalled `startedCh`, so the
// test genuinely exercises the in-flight dedup layer without depending on
// wall-clock pacing (which flakes on loaded Windows CI runners). Without this
// barrier the first job can finish before the second delivery is considered
// and the in-flight path is never actually exercised.
func TestDispatchDeduplicatesInFlightJobs(t *testing.T) {
	p := &fakePrinter{
		blocked:   make(chan struct{}),
		startedCh: make(chan string, 1),
	}
	ag := newTestAgent(t, "p1", p)

	ag.dispatchJob(context.Background(), dispatchTestJob("dup_ws_poll", "p1"))

	select {
	case <-p.startedCh:
		// First copy is now physically printing and parked on `blocked`.
	case <-time.After(10 * time.Second):
		t.Fatal("first print never started")
	}

	// Second delivery of the same job arrives while the first is in flight:
	// it MUST be dropped by dispatchJob's in-flight dedup immediately.
	ag.dispatchJob(context.Background(), dispatchTestJob("dup_ws_poll", "p1"))

	close(p.blocked) // release the first print

	ag.waitForJobs()
	if p.calls != 1 {
		t.Fatalf("expected exactly 1 print for duplicate deliveries, got %d", p.calls)
	}
}

// PHASE 3 (mandatory): a job physically delivered over WebSocket whose
// Gateway-side delivered_at evidence write LOST is requeued and redelivered
// under a FRESH claim token. If the agent is still executing the first
// delivery, the second (differently-tokened) envelope must NOT produce a
// second physical write. This is the exact race the gateway's
// releaseUndeliveredClaim path can trigger, proven end-to-end on the agent
// side with a counting transport: physical dispatch is at-most-once.
func TestDuplicateDeliveryWithFreshClaimTokenDoesNotReprint(t *testing.T) {
	p := &fakePrinter{
		blocked:   make(chan struct{}),
		startedCh: make(chan string, 1),
	}
	ag := newTestAgent(t, "p1", p)

	// First delivery, claim token A; it parks mid-print.
	first := dispatchTestJob("evidence_loss_race", "p1")
	first["claimToken"] = "token-A"
	ag.dispatchJob(context.Background(), first)
	select {
	case <-p.startedCh:
	case <-time.After(10 * time.Second):
		t.Fatal("first print never started")
	}

	// Redelivery with a DIFFERENT token (the reclaim that follows a lost
	// evidence write). Same job id.
	second := dispatchTestJob("evidence_loss_race", "p1")
	second["claimToken"] = "token-B"
	ag.dispatchJob(context.Background(), second)

	close(p.blocked) // release the first print
	ag.waitForJobs()

	if got := p.callsByJob["evidence_loss_race"]; got != 1 {
		t.Fatalf("redelivery with a fresh claim token must NOT reprint: physical writes=%d, want 1", got)
	}
}

// A burst of jobs must execute completely (bounded executor) and be fully
// drained by waitForJobs during shutdown.
func TestDispatchBoundedAndDrained(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)

	const n = 8
	for i := 0; i < n; i++ {
		ag.dispatchJob(context.Background(), dispatchTestJob(
			"burst_"+string(rune('a'+i)), "p1"))
	}

	start := time.Now()
	ag.waitForJobs()
	elapsed := time.Since(start)

	// The real invariant is "all jobs drained well below the 25s shutdown
	// grace". The exact wall-clock figure is load-proportional (SQLite temp
	// DBs + loopback HTTP on 2-vCPU Windows runners), so keep 20s as a safety
	// bound instead of a house number — a drain that is merely slow must not
	// fail the build.
	if elapsed > 20*time.Second {
		t.Fatalf("drain took unexpectedly long: %v", elapsed)
	}
	if p.calls != n {
		t.Fatalf("expected %d prints, got %d", n, p.calls)
	}
}

// After beginShutdown, dispatchJob must refuse new work entirely.
func TestDispatchRejectsAfterShutdown(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)

	ag.beginShutdown()
	ag.dispatchJob(context.Background(), dispatchTestJob("late_job", "p1"))

	start := time.Now()
	ag.waitForJobs()
	if time.Since(start) > 2*time.Second {
		t.Fatalf("waitForJobs should return immediately with no accepted jobs")
	}
	if p.calls != 0 {
		t.Fatalf("job dispatched after shutdown must not print, got %d calls", p.calls)
	}
}

// TestWaitForJobsNeverBlocksShutdownForever locks the documented shutdown
// contract: Run/Stop must return after at most shutdownGrace even when a
// worker is wedged (e.g. a spooler post-cancel wait that outruns the grace,
// or a detached PDF budget). The bounded return is what makes service stop
// safe together with crash recovery: surviving writes land, missed ones are
// recovered honestly as interrupted/unknown on restart. This must keep
// passing if anyone touches the grace, the wait, or the close ordering.
func TestWaitForJobsNeverBlocksShutdownForever(t *testing.T) {
	ag := newTestAgent(t, "p1", &fakePrinter{})
	ag.inFlightMu.Lock()
	ag.inFlight["wedged_job"] = struct{}{}
	ag.inFlightMu.Unlock()
	ag.wg.Add(1) // simulate a handler that never returns (wedged syscall)
	start := time.Now()
	drained := ag.waitForJobs()
	elapsed := time.Since(start)
	if drained {
		t.Fatal("waitForJobs must report a grace-period timeout while an in-flight handler remains")
	}
	if elapsed < shutdownGrace {
		t.Fatalf("waitForJobs returned after %v, before the %v grace - in-flight work was not awaited", elapsed, shutdownGrace)
	}
	if elapsed > shutdownGrace+15*time.Second {
		t.Fatalf("waitForJobs blocked %v, beyond the %v grace + margin - bounded shutdown wait regressed", elapsed, shutdownGrace)
	}

	// The production caller keeps SQLite open after this bounded result and
	// waits for the handler to terminate. Simulate that final termination
	// before exercising Close.
	ag.inFlightMu.Lock()
	delete(ag.inFlight, "wedged_job")
	ag.inFlightMu.Unlock()
	ag.wg.Done()
	if !ag.waitForJobs() {
		t.Fatal("waitForJobs should drain immediately after the accepted handler terminates")
	}
	if err := ag.Close(); err != nil {
		t.Fatalf("Close after drained shutdown must succeed: %v", err)
	}
}

// TestSamePrinterWaitersDoNotConsumeGlobalExecutionSlots protects the fairness
// invariant introduced in the print executor: jobs blocked on one printer's
// per-printer mutex must not occupy all global execution slots and starve an
// unrelated printer. The test uses the existing fake printer's barrier plus
// the Gateway status callback as a deterministic phase boundary: once all
// eight printing reports have been accepted, the first printer owns the
// physical slot and the other seven are known to be waiting for that printer.
func TestSamePrinterWaitersDoNotConsumeGlobalExecutionSlots(t *testing.T) {
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "1")
	const blockedJobs = maxConcurrentJobs

	var mu sync.Mutex
	printingReports := make(map[string]struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/jobs" && r.Method == http.MethodPatch {
			var body map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			if body["status"] == "printing" {
				if id, ok := body["jobId"].(string); ok {
					mu.Lock()
					printingReports[id] = struct{}{}
					mu.Unlock()
				}
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		if r.URL.Path == "/api/agent/jobs" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[]`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	p1 := &fakePrinter{blocked: make(chan struct{}), startedCh: make(chan string, 1)}
	p2 := &fakePrinter{startedCh: make(chan string, 1)}
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	ag.printers = map[string]printer.Printer{"p1": p1, "p2": p2}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "Slow", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
	allowInjectedPrintersForTest(ag)
		"p2": {ID: "p2", Name: "Fast", Type: "network", Endpoint: "127.0.0.1:9101", Protocol: "raw"},
	}

	for i := 0; i < blockedJobs; i++ {
		id := fmt.Sprintf("slow_%d", i)
		ag.dispatchJob(context.Background(), dispatchTestJob(id, "p1"))
	}

	select {
	case <-p1.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("slow printer did not reach physical execution")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		count := len(printingReports)
		mu.Unlock()
		if count == blockedJobs {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected %d printing reports before probing unrelated printer, got %d", blockedJobs, count)
		}
		time.Sleep(5 * time.Millisecond)
	}

	// With the corrected executor, the unrelated printer can start immediately
	// even though p1 has maxConcurrentJobs jobs in-flight at the agent level.
	ag.dispatchJob(context.Background(), dispatchTestJob("fast_1", "p2"))
	select {
	case <-p2.startedCh:
		// Expected: p2 was not starved by p1's per-printer waiters.
	case <-time.After(2 * time.Second):
		t.Fatal("unrelated printer was starved while same-printer jobs waited")
	}

	close(p1.blocked)
	ag.waitForJobs()
	if got := p2.Calls(); got != 1 {
		t.Fatalf("expected unrelated printer to execute exactly once, got %d", got)
	}
}

func TestDispatchSaturationDoesNotBlockOnRejectNetworkCall(t *testing.T) {
	var mu sync.Mutex
	rejectCalls := 0
	rejectStarted := make(chan struct{})
	releaseReject := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/jobs" || r.Method != http.MethodPatch {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		rejectCalls++
		count := rejectCalls
		mu.Unlock()
		if count == 1 {
			close(rejectStarted)
		}
		<-releaseReject
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer ag.Close()

	// Saturate the local admission queue without starting physical work. This
	// drives the exact dispatch path that historically performed a blocking
	// HTTP PATCH from the WS reader.
	for i := 0; i < maxPendingJobs; i++ {
		ag.pendingSlots <- struct{}{}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ag.launchTracked(func() { ag.runRejectWorker(ctx) })

	job := dispatchTestJob("job_reject_backpressure", "p1")
	job["claimToken"] = "claim-reject-1"

	start := time.Now()
	if ag.dispatchJob(ctx, job) {
		t.Fatal("saturated admission must reject the job locally")
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("dispatchJob blocked on rejection network I/O for %v", elapsed)
	}

	select {
	case <-rejectStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("bounded rejection worker never started the PATCH")
	}

	// A duplicate WS/poll delivery with the SAME claim must not enqueue a
	// second concurrent rejection while the first PATCH is still blocked.
	ag.dispatchJob(ctx, job)
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	count := rejectCalls
	mu.Unlock()
	if count != 1 {
		t.Fatalf("expected one in-flight rejection PATCH for the same claim, got %d", count)
	}

	close(releaseReject)
	cancel()
	ag.runtimeWG.Wait()
}

func TestQueuedRejectionIsCancelledWithItsSession(t *testing.T) {
	var mu sync.Mutex
	rejectCalls := 0
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/jobs" || r.Method != http.MethodPatch {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		rejectCalls++
		count := rejectCalls
		mu.Unlock()
		if count == 1 {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer ag.Close()

	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	ag.launchTracked(func() { ag.runRejectWorker(workerCtx) })

	firstCtx := context.Background()
	secondCtx, secondCancel := context.WithCancel(context.Background())
	defer secondCancel()

	if !ag.enqueueReject(firstCtx, "job_reject_first", "claim-A", "pending_full") {
		t.Fatal("first rejection should be queued")
	}
	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("first rejection did not reach the gateway")
	}
	if !ag.enqueueReject(secondCtx, "job_reject_second", "claim-B", "pending_full") {
		t.Fatal("second rejection should be queued behind the first")
	}

	// Closing the WS session cancels its queued rejection before the worker can
	// issue a stale mutation after reconnect.
	secondCancel()
	close(releaseFirst)
	time.Sleep(150 * time.Millisecond)

	mu.Lock()
	count := rejectCalls
	mu.Unlock()
	if count != 1 {
		t.Fatalf("cancelled queued session work must not issue a second PATCH, got %d calls", count)
	}

	workerCancel()
	ag.runtimeWG.Wait()
}

func TestEnqueueRejectPreservesOriginalClaimToken(t *testing.T) {
	ag := newTestAgent(t, "p1", &fakePrinter{})
	ag.inFlightMu.Lock()
	ag.inFlight["job_token_fence"] = struct{}{}
	ag.inFlightTokens["job_token_fence"] = "claim-new"
	ag.inFlightMu.Unlock()

	ctx := context.Background()
	if !ag.enqueueReject(ctx, "job_token_fence", "claim-old", "pending_full") {
		t.Fatal("expected rejection to be queued")
	}

	select {
	case work := <-ag.rejectQueue:
		if work.claimToken != "claim-old" {
			t.Fatalf("queued rejection must preserve the token captured from the delivery, got %q", work.claimToken)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("queued rejection was not available")
	}
}
