package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestAgentIdentityConflictRefusesHardwareWithoutRequeueingAnotherPayload(t *testing.T) {
	physical := &fakePrinter{}
	ag := newTestAgent(t, "p1", physical)
	const jobID = "immutable-fenced-job"
	original := []byte("original receipt, do not substitute")
	if err := ag.queue.ReserveBeforeDispatch(jobID, "p1", original, "claim-original"); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var reports []map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path != "/api/agent/jobs" && r.URL.Path != "/api/agent/ack") || (r.Method != http.MethodPatch && r.Method != http.MethodPost) {
			http.NotFound(w, r)
			return
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		mu.Lock()
		reports = append(reports, body)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
	}))
	defer server.Close()
	ag.cfg.Server.URL = server.URL

	// A duplicate cloud job ID cannot substitute the payload while retaining
	// the same printer. It must not be refunded to "queued" in a retry loop.
	ag.processJob(context.Background(), dispatchTestJob(jobID, "p1"))

	if got := physical.Calls(); got != 0 {
		t.Fatalf("conflicting durable operation sent %d hardware attempts", got)
	}
	_, status, present, err := ag.queue.Get(jobID)
	if err != nil || !present || status != "queued" {
		t.Fatalf("original pre-dispatch evidence must remain queued: %q present=%v err=%v", status, present, err)
	}
	if got := ag.queue.ClaimTokenFor(jobID); got != "claim-original" {
		t.Fatalf("identity conflict overwrote original local claim: %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reports) != 1 {
		t.Fatalf("expected exactly one terminal refusal, got %#v", reports)
	}
	if reports[0]["status"] != "failed" {
		t.Fatalf("identity conflict was requeued instead of terminally refused: %#v", reports[0])
	}
	if reports[0]["claimToken"] != "claim-"+jobID {
		t.Fatalf("terminal refusal did not use exact current Gateway claim token: %#v", reports[0])
	}
	if reports[0]["error"] != "JOB_IDENTITY_MISMATCH: local durable record has another printer or payload; no bytes sent" {
		t.Fatalf("identity conflict was not reported as known pre-execution failure: %#v", reports[0])
	}
}
