package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTerminalDuplicateKeepsOriginalClaimAfterAck(t *testing.T) {
	var token string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		token, _ = body["claimToken"].(string)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
	}))
	defer server.Close()
	p := &fakePrinter{}
	a := newTestAgent(t, "p1", p)
	a.cfg.Server.URL = server.URL
	if err := a.queue.BeginPrint("durable-result", "p1", []byte("document"), "original-execution-claim", false); err != nil {
		t.Fatal(err)
	}
	if err := a.queue.UpdateTerminalWithEvidence("durable-result", "success", "", "spool-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.queue.ClearClaimToken("durable-result", "original-execution-claim"); err != nil {
		t.Fatal(err)
	}
	job := dispatchTestJob("durable-result", "p1")
	job["claimToken"] = "unrelated-new-claim"
	a.processJob(context.Background(), job)
	if token != "original-execution-claim" {
		t.Fatalf("durable terminal result adopted a different execution claim: %q", token)
	}
	if p.Calls() != 0 {
		t.Fatal("duplicate terminal delivery executed output again")
	}
}
