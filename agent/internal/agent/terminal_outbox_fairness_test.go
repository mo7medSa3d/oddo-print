package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTerminalOutboxRejectedPrefixCannotStarveLaterOutcome(t *testing.T) {
	acknowledged := false
	beforeCursorAcknowledged := false
	staleAttempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var report struct {
			ID    string `json:"jobId"`
			Token string `json:"claimToken"`
		}
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Error(err)
			return
		}
		if report.Token != "claim-"+report.ID {
			t.Errorf("outbox adopted a replacement claim for %s", report.ID)
		}
		if report.ID == "000-new-success" {
			beforeCursorAcknowledged = true
		} else if report.ID != "zz-later-success" {
			staleAttempts++
			http.Error(w, "original claim no longer reconcilable", http.StatusConflict)
			return
		}
		acknowledged = true
		_, _ = w.Write([]byte(`{"success":true,"status":"success"}`))
	}))
	defer server.Close()
	a := newTestAgent(t, "p1", &fakePrinter{})
	a.cfg.Server.URL = server.URL
	for i := 0; i < 33; i++ {
		id := fmt.Sprintf("stale-%02d", i)
		if i == 32 {
			id = "zz-later-success"
		}
		if err := a.queue.BeginPrint(id, "p1", []byte("receipt"), "claim-"+id, false); err != nil {
			t.Fatal(err)
		}
		if err := a.queue.UpdateTerminalWithEvidence(id, "success", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	// There are only two batches of durable evidence. Even if the first
	// batch is permanently rejected, the later physical result must be sent.
	for i := 0; i < 3; i++ {
		a.reportPendingTerminalStatuses(context.Background())
	}
	if !acknowledged || a.queue.ClaimTokenFor("zz-later-success") != "" {
		t.Fatal("unacknowledged terminal prefix starved a later physical outcome")
	}
	// Rejection never discards the original terminal evidence or token.
	if token := a.queue.ClaimTokenFor("stale-00"); token != "claim-stale-00" {
		t.Fatalf("rejected physical evidence was discarded: %q", token)
	}
	if staleAttempts != 64 {
		t.Fatalf("outbox did not wrap and retry preserved original claims: %d attempts", staleAttempts)
	}
	// New IDs may sort before an existing cursor. Reaching the end wraps,
	// rather than permanently skipping these newly completed outcomes.
	if err := a.queue.BeginPrint("000-new-success", "p1", []byte("receipt"), "claim-000-new-success", false); err != nil {
		t.Fatal(err)
	}
	if err := a.queue.UpdateTerminalWithEvidence("000-new-success", "success", "", ""); err != nil {
		t.Fatal(err)
	}
	a.reportPendingTerminalStatuses(context.Background())
	if !beforeCursorAcknowledged || a.queue.ClaimTokenFor("000-new-success") != "" {
		t.Fatal("new terminal ID before replay cursor was skipped after wrap")
	}
	// Restart loses only the scheduling cursor. Durable evidence and exact
	// original tokens remain readable and are retried from the beginning.
	if err := a.queue.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(a.cfg, a.configPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	previousAttempts := staleAttempts
	restarted.reportPendingTerminalStatuses(context.Background())
	if staleAttempts != previousAttempts+32 || restarted.queue.ClaimTokenFor("stale-00") != "claim-stale-00" {
		t.Fatal("restart lost pending original claims or skipped the first replay batch")
	}
}

func TestTerminalOutboxWrapIsNotPostponedByContinuousLaterIDs(t *testing.T) {
	acknowledged := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var report struct {
			ID string `json:"jobId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Error(err)
			return
		}
		if report.ID != "000-success" {
			http.Error(w, "stale original claim", http.StatusConflict)
			return
		}
		acknowledged = true
		_, _ = w.Write([]byte(`{"success":true,"status":"success"}`))
	}))
	defer server.Close()
	a := newTestAgent(t, "p1", &fakePrinter{})
	a.cfg.Server.URL = server.URL
	insert := func(id string) {
		t.Helper()
		if err := a.queue.BeginPrint(id, "p1", []byte("receipt"), "claim-"+id, false); err != nil {
			t.Fatal(err)
		}
		if err := a.queue.UpdateTerminalWithEvidence(id, "success", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 32; i++ {
		insert(fmt.Sprintf("stale-%02d", i))
	}
	a.reportPendingTerminalStatuses(context.Background())
	insert("000-success")
	// Keep extending the end of the ID range before each replay. A scan
	// without a fixed upper boundary never wraps to the newly completed ID.
	for i := 0; i < 4; i++ {
		insert(fmt.Sprintf("zz-new-%02d", i))
		a.reportPendingTerminalStatuses(context.Background())
	}
	if !acknowledged {
		t.Fatal("later arrivals indefinitely postponed replay of an ID before the cursor")
	}
}
