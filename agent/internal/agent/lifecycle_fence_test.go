package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A 409 carrying a lifecycle verdict must fence execution: no new dispatch,
// polls skipped, reason recorded.
func TestHeartbeat409DisabledFencesExecution(t *testing.T) {
	ag := newTestAgent(t, "printer_1", &fakePrinter{})
	ag.noteHeartbeatRejection(http.StatusConflict, []byte(`{"error":"Agent is disabled"}`))
	if !ag.fencedForDispatch() {
		t.Fatal("409 disabled must fence execution")
	}
	if got := ag.fenceReason(); got == "" || !strings.Contains(strings.ToLower(got), "disabled") {
		t.Fatalf("fence reason must name the verdict, got %q", got)
	}
	if !ag.lifecycleBackoffActive() {
		t.Fatal("409 must arm the poll backoff")
	}
}

// Retired fences exactly like disabled.
func TestHeartbeat409RetiredFencesExecution(t *testing.T) {
	ag := newTestAgent(t, "printer_1", &fakePrinter{})
	ag.noteHeartbeatRejection(http.StatusConflict, []byte(`{"error":"Agent is retired"}`))
	if !ag.fencedForDispatch() {
		t.Fatal("409 retired must fence execution")
	}
}

// A 401 keeps re-pair semantics (no fence — the credential, not the
// lifecycle, is at fault) but must bound poll retries.
func TestHeartbeat401BacksOffWithoutFencing(t *testing.T) {
	ag := newTestAgent(t, "printer_1", &fakePrinter{})
	ag.noteHeartbeatRejection(http.StatusUnauthorized, []byte(`{"error":"Unauthorized"}`))
	if ag.fencedForDispatch() {
		t.Fatal("401 must not fence execution (credential fault, not lifecycle)")
	}
	if !ag.lifecycleBackoffActive() {
		t.Fatal("401 must arm the poll backoff")
	}
}

// Any other rejection backs off briefly without fencing (fail open: only a
// lifecycle 409 proves the agent must stop executing).
func TestHeartbeat500BacksOffBrieflyWithoutFencing(t *testing.T) {
	ag := newTestAgent(t, "printer_1", &fakePrinter{})
	ag.noteHeartbeatRejection(http.StatusInternalServerError, []byte(`boom`))
	if ag.fencedForDispatch() {
		t.Fatal("5xx must not fence execution")
	}
	if !ag.lifecycleBackoffActive() {
		t.Fatal("5xx must arm a short backoff")
	}
}

// A fully successful heartbeat clears fence and backoff: re-enable (or a
// key fix) resumes autonomously.
func TestSuccessfulHeartbeatClearsFence(t *testing.T) {
	ag := newTestAgent(t, "printer_1", &fakePrinter{})
	ag.noteHeartbeatRejection(http.StatusConflict, []byte(`{"error":"Agent is disabled"}`))
	if !ag.fencedForDispatch() {
		t.Fatal("precondition: fenced")
	}
	ag.clearLifecycleFence()
	if ag.fencedForDispatch() {
		t.Fatal("successful heartbeat must clear the fence")
	}
	if ag.lifecycleBackoffActive() {
		t.Fatal("successful heartbeat must clear the backoff")
	}
}

// End-to-end through the real heartbeat path: a 409-disabled Gateway
// response fences the agent; the next 200 clears it.
func TestSendHeartbeatFencesAndRecovers(t *testing.T) {
	mode := http.StatusConflict
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/heartbeat" {
			http.NotFound(w, r)
			return
		}
		if mode == http.StatusConflict {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"Agent is disabled"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(server.Close)
	ag := newTestAgent(t, "printer_1", &fakePrinter{})
	ag.cfg.Server.URL = server.URL

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ag.sendHeartbeatContext(ctx)
	if !ag.fencedForDispatch() {
		t.Fatal("heartbeat 409-disabled must fence execution")
	}
	mode = http.StatusOK
	ag.sendHeartbeatContext(ctx)
	if ag.fencedForDispatch() {
		t.Fatal("heartbeat 200 must clear the fence")
	}
}
