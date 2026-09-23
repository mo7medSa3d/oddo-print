package queue

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func newTestQueue(t *testing.T) *Queue {
	t.Helper()
	q, err := New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = q.Close() })
	return q
}

func TestQueueIdempotencyAndStatus(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	q, err := New(dbPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer q.Close()

	id := "job_test123"
	if err := q.Push(id, "printer_1", []byte("hello")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	// duplicate push is idempotent (INSERT OR IGNORE)
	if err := q.Push(id, "printer_1", []byte("hello again")); err != nil {
		t.Fatalf("second Push: %v", err)
	}
	// still not processed
	if q.IsProcessed(id) {
		t.Fatalf("should not be processed yet")
	}
	// Get
	pid, status, found, err := q.Get(id)
	if err != nil || !found {
		t.Fatalf("Get failed: %v found=%v", err, found)
	}
	if pid != "printer_1" || status != "queued" {
		t.Fatalf("unexpected Get: %s %s", pid, status)
	}
	// transition to printing then success
	if err := q.UpdateStatus(id, "printing"); err != nil {
		t.Fatalf("UpdateStatus printing: %v", err)
	}
	if err := q.UpdateStatus(id, "success"); err != nil {
		t.Fatalf("UpdateStatus success: %v", err)
	}
	if !q.IsProcessed(id) {
		t.Fatalf("should be processed after success")
	}
	// reopen from same file survives restart
	q2, err := New(dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer q2.Close()
	if !q2.IsProcessed(id) {
		t.Fatalf("should survive reopen")
	}
	n, err := q2.CountByStatus("success")
	if err != nil {
		t.Fatalf("CountByStatus: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 success, got %d", n)
	}
}

func TestTerminalStatusClearsClaimToken(t *testing.T) {
	q := newTestQueue(t)

	if err := q.Push("success-token", "p1", []byte("data")); err != nil {
		t.Fatalf("Push success-token: %v", err)
	}
	if _, err := q.db.Exec(`UPDATE print_jobs SET claim_token = ? WHERE id = ?`, "gateway-claim-success", "success-token"); err != nil {
		t.Fatalf("seed success claim token: %v", err)
	}
	if err := q.UpdateStatus("success-token", "success"); err != nil {
		t.Fatalf("UpdateStatus success: %v", err)
	}
	if got := q.ClaimTokenFor("success-token"); got != "" {
		t.Fatalf("terminal success must clear claim token, got %q", got)
	}

	if err := q.Push("failed-token", "p1", []byte("data")); err != nil {
		t.Fatalf("Push failed-token: %v", err)
	}
	if _, err := q.db.Exec(`UPDATE print_jobs SET claim_token = ? WHERE id = ?`, "gateway-claim-failed", "failed-token"); err != nil {
		t.Fatalf("seed failed claim token: %v", err)
	}
	if err := q.UpdateStatusWithError("failed-token", "failed", "UNKNOWN_PARTIAL_DELIVERY: ambiguous"); err != nil {
		t.Fatalf("UpdateStatusWithError failed: %v", err)
	}
	if got := q.ClaimTokenFor("failed-token"); got != "" {
		t.Fatalf("terminal failure must clear claim token, got %q", got)
	}
}

func TestMarkInterruptedPreservesClaimForRemoteRecovery(t *testing.T) {
	q := newTestQueue(t)

	if err := q.Push("crash-token", "p1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("crash-token", "printing"); err != nil {
		t.Fatalf("UpdateStatus printing: %v", err)
	}
	if _, err := q.db.Exec(`UPDATE print_jobs SET claim_token = ? WHERE id = ?`, "gateway-crash-token", "crash-token"); err != nil {
		t.Fatalf("seed claim token: %v", err)
	}

	interrupted, err := q.MarkInterrupted()
	if err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}
	if len(interrupted) != 1 || interrupted[0].ClaimToken != "gateway-crash-token" {
		t.Fatalf("crash recovery must retain the pre-read claim token for reporting, got %#v", interrupted)
	}
	if got := q.ClaimTokenFor("crash-token"); got != "" {
		t.Fatalf("terminal interruption row must clear stored claim token, got %q", got)
	}
}

func TestQueueUpdateWithError(t *testing.T) {
	dir := t.TempDir()
	q, err := New(filepath.Join(dir, "x.db"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer q.Close()
	if err := q.Push("j1", "p1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatusWithError("j1", "failed", "dial timeout"); err != nil {
		t.Fatalf("UpdateStatusWithError: %v", err)
	}
	_, status, _, _ := q.Get("j1")
	if status != "failed" {
		t.Fatalf("expected failed, got %s", status)
	}
}

// A job left in 'printing' by a crash must become a terminal local failure
// carrying the interruption marker, so the ambiguity is explicit instead of
// looking like a normal transient failure.
func TestMarkInterruptedFlagsMidPrintJobs(t *testing.T) {
	q := newTestQueue(t)

	if err := q.Push("job_crash", "printer_1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("job_crash", "printing"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	if err := q.Push("job_done", "printer_1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("job_done", "success"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}

	interrupted, err := q.MarkInterrupted()
	if err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}
	if len(interrupted) != 1 || interrupted[0].ID != "job_crash" || interrupted[0].PrinterID != "printer_1" {
		t.Fatalf("expected only job_crash to be interrupted, got %#v", interrupted)
	}

	_, status, found, err := q.Get("job_crash")
	if err != nil || !found {
		t.Fatalf("Get(job_crash): found=%v err=%v", found, err)
	}
	if status != "failed" {
		t.Fatalf("interrupted job must be terminal locally, got %q", status)
	}
	if !q.WasInterrupted("job_crash") {
		t.Fatal("interrupted job must be detectable via WasInterrupted")
	}
	if q.WasInterrupted("job_done") {
		t.Fatal("a completed job must never be reported as interrupted")
	}

	// Idempotent: a second startup finds nothing left in 'printing'.
	again, err := q.MarkInterrupted()
	if err != nil {
		t.Fatalf("MarkInterrupted (2nd): %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("second scan must find nothing, got %#v", again)
	}
}

// The unknown-outcome marker TEXT is the contract between the agent, the
// gateway (src/lib/job-status.ts: PHYSICAL_OUTCOME_UNKNOWN_MARKERS) and Odoo
// (print_gateway.print_job._GATEWAY_UNKNOWN_MARKERS). WasOutcomeUnknown must
// recognize every canonical marker: a locally-failed job carrying ANY of
// them may have produced paper and must never be silently reprinted. This
// locks the list against drift back to a subset.
func TestUnknownOutcomeMarkersMatchCanonicalContract(t *testing.T) {
	want := []string{
		"AGENT_EXECUTION_TIMEOUT",
		"AGENT_RESTART_DURING_PRINT",
		"JOB_EXPIRED_DURING_PRINT",
		"UNKNOWN_PARTIAL_DELIVERY",
		"UNKNOWN_SUBMISSION_OUTCOME",
	}
	if len(UnknownOutcomeMarkers) != len(want) {
		t.Fatalf("UnknownOutcomeMarkers = %v, want %v", UnknownOutcomeMarkers, want)
	}
	for i, marker := range want {
		if UnknownOutcomeMarkers[i] != marker {
			t.Fatalf("UnknownOutcomeMarkers[%d] = %q, want %q", i, UnknownOutcomeMarkers[i], marker)
		}
	}

	q := newTestQueue(t)
	for _, marker := range want {
		id := "job_unknown_" + marker
		if err := q.Push(id, "printer_1", []byte("x")); err != nil {
			t.Fatalf("Push(%s): %v", id, err)
		}
		if err := q.UpdateStatusWithError(id, "failed", marker+": ambiguous physical outcome"); err != nil {
			t.Fatalf("UpdateStatusWithError(%s): %v", id, err)
		}
		if !q.WasOutcomeUnknown(id) {
			t.Fatalf("WasOutcomeUnknown(%s) = false, want true for marker %q", id, marker)
		}
	}
	// A provably pre-dispatch failure stays reprintable: it must NOT be
	// classified as an unknown outcome.
	if err := q.Push("job_plain_fail", "printer_1", []byte("x")); err != nil {
		t.Fatalf("Push(job_plain_fail): %v", err)
	}
	if err := q.UpdateStatusWithError("job_plain_fail", "failed", "dial tcp: connection refused"); err != nil {
		t.Fatalf("UpdateStatusWithError(job_plain_fail): %v", err)
	}
	if q.WasOutcomeUnknown("job_plain_fail") {
		t.Fatal("WasOutcomeUnknown(job_plain_fail) = true, want false for a provably pre-dispatch failure")
	}
}

// FIX-2 regression: BeginPrint must be state-safe at the PRIMITIVE level.
// Terminal or unknown local ledger states must never be reopened into
// 'printing' by the normal dispatch path - the duplicate-print defense may
// not rely on callers (processJob) checking first.
func TestBeginPrintCannotReopenTerminalOrUnknownStates(t *testing.T) {
	dbPath := t.TempDir() + "/agent.db"
	q, err := New(dbPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer q.Close()

	settle := func(id, status, lastErr string) {
		if err := q.Push(id, "printer-1", []byte("payload")); err != nil {
			t.Fatalf("Push(%s): %v", id, err)
		}
		if _, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ? WHERE id = ?`, status, lastErr, id); err != nil {
			t.Fatalf("settle(%s): %v", id, err)
		}
	}

	cases := []struct {
		name        string
		id          string
		status      string // "" => brand-new row (no Push); otherwise settled state
		lastErr     string
		allowReopen bool
		wantErr     bool
		wantStatus  string
	}{
		{name: "new job begins", id: "bp_new", status: "", wantErr: false, wantStatus: "printing"},
		{name: "queued begins", id: "bp_queued", status: "queued", wantErr: false, wantStatus: "printing"},
		{name: "printing re-begins (in-session idempotency)", id: "bp_printing", status: "printing", wantErr: false, wantStatus: "printing"},
		{name: "provable failure retries", id: "bp_failed_plain", status: "failed", lastErr: "paper jam before transmission", wantErr: false, wantStatus: "printing"},
		{name: "success never reopens", id: "bp_success", status: "success", wantErr: true, wantStatus: "success"},
		{name: "success never reopens even with reopen flag", id: "bp_success_flag", status: "success", allowReopen: true, wantErr: true, wantStatus: "success"},
		{name: "unknown partial refuses normal path", id: "bp_unknown", status: "failed", lastErr: "UNKNOWN_PARTIAL_DELIVERY: write failed after 3/9 bytes", wantErr: true, wantStatus: "failed"},
		{name: "restart interrupt refuses normal path", id: "bp_interrupt", status: "failed", lastErr: InterruptedMarker + ": process died mid-print", wantErr: true, wantStatus: "failed"},
		{name: "unknown reopens ONLY via explicit reprint opt-in", id: "bp_unknown_optin", status: "failed", lastErr: "UNKNOWN_PARTIAL_DELIVERY: ambiguous", allowReopen: true, wantErr: false, wantStatus: "printing"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.status != "" {
				settle(tc.id, tc.status, tc.lastErr)
			}
			if tc.id == "bp_printing" {
				if _, err := q.db.Exec(`UPDATE print_jobs SET claim_token = ? WHERE id = ?`, "token-"+tc.id, tc.id); err != nil {
					t.Fatalf("seed live claim token: %v", err)
				}
			}
			err := q.BeginPrint(tc.id, "printer-1", []byte("payload"), "token-"+tc.id, tc.allowReopen)
			if tc.wantErr {
				if !errors.Is(err, ErrTerminalState) {
					t.Fatalf("BeginPrint error = %v, want ErrTerminalState", err)
				}
				// the row must be untouched: still terminal, still not printing
				if _, status, found, err := q.Get(tc.id); err != nil || !found || status != tc.wantStatus {
					t.Fatalf("after refusal row = %q found=%v err=%v, want unchanged %q", status, found, err, tc.wantStatus)
				}
				if claim := q.ClaimTokenFor(tc.id); claim == "token-"+tc.id {
					t.Fatal("refused BeginPrint must not overwrite the stored claim token")
				}
				return
			}
			if err != nil {
				t.Fatalf("BeginPrint: unexpected error %v", err)
			}
			if _, status, _, err := q.Get(tc.id); err != nil || status != "printing" {
				t.Fatalf("after allow: status=%q err=%v, want printing", status, err)
			}
			if claim := q.ClaimTokenFor(tc.id); claim != "token-"+tc.id {
				t.Fatalf("allowed BeginPrint must record the attempt's claim token, got %q", claim)
			}
		})
	}
}

func TestBeginPrintRejectsDifferentClaimTokenWhilePrinting(t *testing.T) {
	dbPath := t.TempDir() + "/agent.db"
	q, err := New(dbPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer q.Close()

	if err := q.BeginPrint("job_live", "printer-1", []byte("payload"), "claim-A", false); err != nil {
		t.Fatalf("initial BeginPrint: %v", err)
	}
	if err := q.BeginPrint("job_live", "printer-1", []byte("payload"), "claim-B", false); !errors.Is(err, ErrTerminalState) {
		t.Fatalf("different claim token must be rejected while printing, got %v", err)
	}
	if got := q.ClaimTokenFor("job_live"); got != "claim-A" {
		t.Fatalf("rejected attempt must not replace live claim token, got %q", got)
	}
	if err := q.BeginPrint("job_live", "printer-1", []byte("payload"), "claim-A", false); err != nil {
		t.Fatalf("same claim token should remain idempotent: %v", err)
	}
}

func TestBeginPrintRejectsTokenedClaimAgainstLegacyTokenlessPrinting(t *testing.T) {
	q := newTestQueue(t)
	if err := q.Push("legacy-printing", "printer-1", []byte("payload")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("legacy-printing", "printing"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	if err := q.BeginPrint("legacy-printing", "printer-1", []byte("payload"), "new-token", false); !errors.Is(err, ErrTerminalState) {
		t.Fatalf("tokened claimant must not steal tokenless printing row, got %v", err)
	}
	if got := q.ClaimTokenFor("legacy-printing"); got != "" {
		t.Fatalf("legacy claim token must remain empty, got %q", got)
	}
}

func TestBeginPrintSuccessIsTerminalEvenWhenReprintEnabled(t *testing.T) {
	q := newTestQueue(t)
	if err := q.Push("success-terminal", "printer-1", []byte("payload")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("success-terminal", "printing"); err != nil {
		t.Fatalf("UpdateStatus printing: %v", err)
	}
	if err := q.UpdateStatus("success-terminal", "success"); err != nil {
		t.Fatalf("UpdateStatus success: %v", err)
	}
	if err := q.BeginPrint("success-terminal", "printer-1", []byte("payload"), "reprint-token", true); !errors.Is(err, ErrTerminalState) {
		t.Fatalf("success must never reopen, got %v", err)
	}
}

func TestBeginPrintUnknownOutcomeRequiresExplicitReprint(t *testing.T) {
	q := newTestQueue(t)
	if err := q.Push("unknown-terminal", "printer-1", []byte("payload")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("unknown-terminal", "printing"); err != nil {
		t.Fatalf("UpdateStatus printing: %v", err)
	}
	if err := q.UpdateStatusWithError("unknown-terminal", "failed", InterruptedMarker+": physical outcome unknown"); err != nil {
		t.Fatalf("UpdateStatusWithError: %v", err)
	}
	if err := q.BeginPrint("unknown-terminal", "printer-1", []byte("payload"), "token-1", false); !errors.Is(err, ErrTerminalState) {
		t.Fatalf("unknown outcome must be closed by normal delivery, got %v", err)
	}
	if err := q.BeginPrint("unknown-terminal", "printer-1", []byte("payload"), "token-2", true); err != nil {
		t.Fatalf("explicit operator reprint should reopen unknown outcome: %v", err)
	}
	if got := q.ClaimTokenFor("unknown-terminal"); got != "token-2" {
		t.Fatalf("explicit reprint must persist new claim token, got %q", got)
	}
}

func TestBeginPrintConcurrentClaimersCannotStealToken(t *testing.T) {
	q := newTestQueue(t)
	const jobID = "concurrent-claim"
	const attempts = 8
	var wg sync.WaitGroup
	results := make(chan error, attempts)
	wg.Add(attempts)
	for i := 0; i < attempts; i++ {
		token := fmt.Sprintf("claim-%d", i)
		go func() {
			defer wg.Done()
			results <- q.BeginPrint(jobID, "printer-1", []byte("payload"), token, false)
		}()
	}
	wg.Wait()
	close(results)

	var success int
	for err := range results {
		if err == nil {
			success++
			continue
		}
		if !errors.Is(err, ErrTerminalState) {
			t.Fatalf("unexpected concurrent BeginPrint error: %v", err)
		}
	}
	if success != 1 {
		t.Fatalf("expected exactly one claimant to own a new job, got %d", success)
	}
	owner := q.ClaimTokenFor(jobID)
	if owner == "" {
		t.Fatal("winning claim token must persist")
	}
}

func TestTerminalStatusClearsClaimTimestampAndToken(t *testing.T) {
	q := newTestQueue(t)
	if err := q.BeginPrint("terminal-clear", "printer-1", []byte("payload"), "claim-terminal", false); err != nil {
		t.Fatalf("BeginPrint: %v", err)
	}
	if _, err := q.db.Exec(`UPDATE print_jobs SET claimed_at = CURRENT_TIMESTAMP WHERE id = ?`, "terminal-clear"); err != nil {
		t.Fatalf("seed claimed_at: %v", err)
	}
	if err := q.UpdateStatus("terminal-clear", "success"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	var token interface{}
	var claimedAt interface{}
	if err := q.db.QueryRow(`SELECT claim_token, claimed_at FROM print_jobs WHERE id = ?`, "terminal-clear").Scan(&token, &claimedAt); err != nil {
		t.Fatalf("read terminal row: %v", err)
	}
	if token != nil || claimedAt != nil {
		t.Fatalf("terminal row retained execution lease state: token=%v claimed_at=%v", token, claimedAt)
	}
}

func TestTerminalStatusWithErrorClearsClaimTimestampAndToken(t *testing.T) {
	q := newTestQueue(t)
	if err := q.BeginPrint("terminal-clear-error", "printer-1", []byte("payload"), "claim-terminal-error", false); err != nil {
		t.Fatalf("BeginPrint: %v", err)
	}
	if _, err := q.db.Exec(`UPDATE print_jobs SET claimed_at = CURRENT_TIMESTAMP WHERE id = ?`, "terminal-clear-error"); err != nil {
		t.Fatalf("seed claimed_at: %v", err)
	}
	if err := q.UpdateStatusWithError("terminal-clear-error", "failed", "paper jam before transmission"); err != nil {
		t.Fatalf("UpdateStatusWithError: %v", err)
	}
	var token interface{}
	var claimedAt interface{}
	if err := q.db.QueryRow(`SELECT claim_token, claimed_at FROM print_jobs WHERE id = ?`, "terminal-clear-error").Scan(&token, &claimedAt); err != nil {
		t.Fatalf("read terminal row: %v", err)
	}
	if token != nil || claimedAt != nil {
		t.Fatalf("terminal row retained execution lease state: token=%v claimed_at=%v", token, claimedAt)
	}
}
