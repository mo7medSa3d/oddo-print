package queue

import (
	"strings"
	"testing"
)

func TestCleanupTerminalRemovesOnlyTerminalJobs(t *testing.T) {
	dbPath := t.TempDir() + "/agent.db"
	q, err := New(dbPath)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer q.Close()

	for _, id := range []string{"queued-job", "printing-job", "success-job", "failed-job"} {
		if err := q.Push(id, "printer-1", []byte("payload")); err != nil {
			t.Fatalf("Push(%s) error = %v", id, err)
		}
	}
	if err := q.UpdateStatus("printing-job", "printing"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatus("success-job", "success"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatus("failed-job", "failed"); err != nil {
		t.Fatal(err)
	}

	deleted, err := q.CleanupTerminal(0)
	if err != nil {
		t.Fatalf("CleanupTerminal() error = %v", err)
	}
	if deleted != 2 {
		t.Fatalf("CleanupTerminal() deleted = %d, want 2", deleted)
	}

	for _, id := range []string{"success-job", "failed-job"} {
		if _, _, found, err := q.Get(id); err != nil {
			t.Fatal(err)
		} else if found {
			t.Fatalf("terminal job %s still exists", id)
		}
	}
	for _, id := range []string{"queued-job", "printing-job"} {
		if _, _, found, err := q.Get(id); err != nil {
			t.Fatal(err)
		} else if !found {
			t.Fatalf("active job %s was removed", id)
		}
	}
}

func TestCleanupTerminalPreservesPendingGatewayReports(t *testing.T) {
	q := newTestQueue(t)
	if err := q.BeginPrint("pending-cleanup", "printer-1", []byte("payload"), "claim-pending", false); err != nil {
		t.Fatalf("BeginPrint: %v", err)
	}
	if err := q.UpdateStatusWithError("pending-cleanup", "failed", "paper jam before transmission"); err != nil {
		t.Fatalf("UpdateStatusWithError: %v", err)
	}
	deleted, err := q.CleanupTerminal(0)
	if err != nil {
		t.Fatalf("CleanupTerminal: %v", err)
	}
	if deleted != 0 {
		t.Fatalf("CleanupTerminal deleted pending report row: %d", deleted)
	}
	if _, _, found, err := q.Get("pending-cleanup"); err != nil || !found {
		t.Fatalf("pending Gateway report row was removed: found=%v err=%v", found, err)
	}
}

// EVERY canonical unknown-outcome marker must survive cleanup: deleting a
// row that carries any unknown-outcome marker destroys the duplicate-print
// evidence base (the row is the local protection against reprinting a
// possibly-already-printed document on a later duplicate delivery).
func TestCleanupTerminalPreservesEveryUnknownOutcomeMarker(t *testing.T) {
	if len(UnknownOutcomeMarkers) < 2 {
		t.Fatalf("canonical marker list unexpectedly small: %v", UnknownOutcomeMarkers)
	}
	for _, marker := range UnknownOutcomeMarkers {
		t.Run(marker, func(t *testing.T) {
			dbPath := t.TempDir() + "/agent.db"
			q, err := New(dbPath)
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			defer q.Close()

			id := "unknown-" + strings.ToLower(strings.ReplaceAll(marker, "_", "-"))
			if err := q.Push(id, "printer-1", []byte("payload")); err != nil {
				t.Fatalf("Push(%s) error = %v", id, err)
			}
			if err := q.UpdateStatusWithError(id, "failed", marker+": evidence detail"); err != nil {
				t.Fatal(err)
			}

			deleted, err := q.CleanupTerminal(0)
			if err != nil {
				t.Fatalf("CleanupTerminal() error = %v", err)
			}
			if _, _, found, err := q.Get(id); err != nil {
				t.Fatal(err)
			} else if !found {
				t.Fatalf("unknown-outcome evidence row %s was deleted by cleanup", id)
			}
			_ = deleted

			n, err := q.CountOutcomeUnknown()
			if err != nil {
				t.Fatal(err)
			}
			if n < 1 {
				t.Fatalf("CountOutcomeUnknown() = %d, want >= 1 for marker %s", n, marker)
			}

			purged, err := q.PurgeOutcomeUnknown()
			if err != nil {
				t.Fatal(err)
			}
			if purged < 1 {
				t.Fatalf("PurgeOutcomeUnknown() = %d, want >= 1 for marker %s", purged, marker)
			}
		})
	}
}

func TestCleanupTerminalOlderThanPurgesAcknowledgedHistoryAfter48Hours(t *testing.T) {
	q := newTestQueue(t)

	for _, id := range []string{"old-success", "old-unknown", "recent-success", "active-old"} {
		if err := q.Push(id, "printer-1", []byte("payload")); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.UpdateStatus("old-success", "success"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatusWithError("old-unknown", "failed", "UNKNOWN_PARTIAL_DELIVERY: historical evidence"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatus("recent-success", "success"); err != nil {
		t.Fatal(err)
	}

	if _, err := q.db.Exec(`UPDATE print_jobs SET updated_at = datetime('now', '-49 hours') WHERE id IN ('old-success','old-unknown','active-old')`); err != nil {
		t.Fatal(err)
	}
	if _, err := q.db.Exec(`UPDATE print_jobs SET updated_at = datetime('now', '-47 hours') WHERE id = 'recent-success'`); err != nil {
		t.Fatal(err)
	}

	deleted, err := q.CleanupTerminalOlderThan(48)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 {
		t.Fatalf("CleanupTerminalOlderThan deleted %d, want 2", deleted)
	}
	for _, id := range []string{"old-success", "old-unknown"} {
		if _, _, found, err := q.Get(id); err != nil || found {
			t.Fatalf("old terminal job %s was not removed: found=%v err=%v", id, found, err)
		}
	}
	for _, id := range []string{"recent-success", "active-old"} {
		if _, _, found, err := q.Get(id); err != nil || !found {
			t.Fatalf("job %s should remain: found=%v err=%v", id, found, err)
		}
	}
}
