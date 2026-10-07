package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestAgentGatewayProducersUseCanonicalPathsWithTrailingSlashAndWhitespace(t *testing.T) {
	type request struct {
		method string
		path   string
	}
	seen := make(chan request, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- request{r.Method, r.URL.Path}
		if r.Header.Get("Authorization") != "Bearer agent:test-secret" {
			t.Errorf("request did not use the paired Agent authentication")
		}
		var update struct {
			JobID      string `json:"jobId"`
			Status     string `json:"status"`
			ClaimToken string `json:"claimToken"`
		}
		if r.URL.Path == "/api/agent/jobs" && r.Method == http.MethodPatch {
			if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&update); err != nil {
				t.Errorf("invalid status request: %v", err)
				http.Error(w, "invalid status request", http.StatusBadRequest)
				return
			}
			if update.JobID != "job" || update.ClaimToken != "claim" || (update.Status != "queued" && update.Status != "printing") {
				t.Errorf("unexpected fenced status request: %+v", update)
			}
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/agent/heartbeat":
			_, _ = w.Write([]byte(`{"success":true}`))
		case "/api/agent/jobs":
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`[]`))
			} else {
				if err := json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": update.Status}); err != nil {
					t.Errorf("encode status acknowledgement: %v", err)
				}
			}
		case "/api/agent/discovery":
			_, _ = w.Write([]byte(`[{"id":"discovery"}]`))
		case "/api/agent/desired-state":
			if r.URL.Query().Get("after") != base64.RawURLEncoding.EncodeToString([]byte("first")) {
				t.Errorf("desired-state cursor was not preserved")
			}
			_, _ = w.Write([]byte(`{"success":true,"agentId":"agent","desiredState":[],"desiredStateNextCursor":""}`))
		default:
			http.Error(w, "noncanonical endpoint", http.StatusNotFound)
		}
	}))
	defer server.Close()
	ag := newDesiredStateTestAgent(t)
	ag.cfg.Server.URL = "  " + server.URL + "/  "
	ag.cfg.Agent.ID, ag.cfg.Agent.Secret = "agent", "test-secret"
	ag.client = server.Client()
	ctx := context.Background()
	ag.sendHeartbeatContext(ctx)
	ag.pollJobs(ctx)
	if err := ag.rejectJobExact(ctx, "job", "claim", "executor_saturated"); err != nil {
		t.Fatal(err)
	}
	if err := ag.updateJobStatus(ctx, "job", "printing", "", "claim", ""); err != nil {
		t.Fatal(err)
	}
	if session := ag.loadDiscoverySession(ctx, "discovery"); session == nil {
		t.Fatal("discovery lookup did not reach the canonical endpoint")
	}
	ag.pollDiscovery(ctx)
	ag.reportDiscoveryResult(ctx, "discovery", "completed", nil)
	first := []desiredPrinterWire{testDesiredPrinter("first", 1, "active")}
	rows, err := ag.collectGatewayDesiredState(ctx, first, base64.RawURLEncoding.EncodeToString([]byte("first")))
	if err != nil || len(rows) != 1 {
		t.Fatalf("desired-state traversal failed: %v", err)
	}
	want := []request{
		{http.MethodPost, "/api/agent/heartbeat"},
		{http.MethodGet, "/api/agent/jobs"},
		{http.MethodPatch, "/api/agent/jobs"},
		{http.MethodPatch, "/api/agent/jobs"},
		{http.MethodGet, "/api/agent/discovery"},
		{http.MethodGet, "/api/agent/discovery"},
		{http.MethodPost, "/api/agent/discovery"},
		{http.MethodGet, "/api/agent/desired-state"},
	}
	got := make([]request, 0, len(want))
	for len(seen) > 0 {
		got = append(got, <-seen)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("actual Gateway requests = %v, want %v", got, want)
	}
}

func TestAgentInvalidOriginFailsBeforeCredentialBearingNetworkRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("invalid origin sent a credential-bearing request")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	ag := newDesiredStateTestAgent(t)
	ag.client = server.Client()
	for _, suffix := range []string{"/base", "/api/", "/?token=test-secret"} {
		ag.cfg.Server.URL = server.URL + suffix
		if _, err := ag.doAuthorizedRequest(context.Background(), http.MethodGet, "/api/agent/jobs", nil); err == nil {
			t.Fatalf("invalid origin accepted: %q", suffix)
		}
		ag.reportDiscoveryResult(context.Background(), "discovery", "completed", nil)
	}
}
