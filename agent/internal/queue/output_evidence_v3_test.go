package queue

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

// Seed a durable file result directly to exercise the actual restart/outbox
// reader independently of the writer. The schema helper also permits the test
// to reproduce the pre-fix reader dropping evidence it did not understand.
func TestTerminalOutboxPreservesFileEvidenceAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox.db")
	q, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.BeginPrint("file-result", "pdf-local", []byte("document"), "original-file-claim", false); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateTerminalWithEvidence("file-result", "success", "", ""); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"output_evidence", "execution_transport"} {
		var count int
		if err := q.db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('print_jobs') WHERE name = ?", column).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			if _, err := q.db.Exec("ALTER TABLE print_jobs ADD COLUMN " + column + " TEXT"); err != nil {
				t.Fatal(err)
			}
		}
	}
	const evidence = `{"output_medium":"file","artifact_id":"opaque_artifact_42","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","page_count":2,"bytes":1200}`
	if _, err := q.db.Exec("UPDATE print_jobs SET output_evidence = ?, execution_transport = ? WHERE id = ?", evidence, "pdf_output", "file-result"); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	q, err = New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	reports, err := q.PendingTerminalReports(4)
	if err != nil || len(reports) != 1 {
		t.Fatalf("restart reports: %#v, %v", reports, err)
	}
	encoded, err := json.Marshal(reports[0])
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]interface{}
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["OutputEvidence"] != evidence || fields["Transport"] != "pdf_output" {
		t.Fatalf("restart outbox discarded exact file result: %s", encoded)
	}
}

func TestTerminalResultIsAtomicImmutableAndKeepsExecutionClaim(t *testing.T) {
	path := filepath.Join(t.TempDir(), "atomic-file.db")
	q, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.BeginPrint("file-once", "kitchen-spooler", []byte("pdf"), "execution-claim", false); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateTerminalResult("file-once", "success", "", "", "windows_spooler", ""); err != nil {
		t.Fatal(err)
	}
	if err := q.ClearClaimToken("file-once", "execution-claim"); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	q, err = New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if pending, err := q.PendingTerminalReports(4); err != nil || len(pending) != 0 {
		t.Fatalf("acknowledged report still pending: %v %v", pending, err)
	}
	if err := q.BeginPrint("file-once", "another-output", []byte("different"), "new-claim", true); !errors.Is(err, ErrTerminalState) {
		t.Fatalf("completed file was reopened: %v", err)
	}
	if err := q.UpdateTerminalResult("file-once", "failed", "new outcome", "", "windows_spooler", ""); !errors.Is(err, ErrTerminalState) {
		t.Fatalf("file result was mutable: %v", err)
	}
	if err := q.UpdateStatus("file-once", "queued"); err != nil {
		t.Fatal(err)
	}
	result, found, err := q.TerminalResultFor("file-once")
	if err != nil || !found || result.ClaimToken != "execution-claim" || result.OutputEvidence != "" || result.Status != "success" || result.Transport != "windows_spooler" {
		t.Fatalf("immutable result changed after restart/replay: %+v %v", result, err)
	}
}

func TestTerminalResultRejectsFileEvidence(t *testing.T) {
	q, err := New(filepath.Join(t.TempDir(), "rejected-evidence.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if err := q.BeginPrint("evidence-rejected", "kitchen-spooler", []byte("pdf"), "claim", false); err != nil {
		t.Fatal(err)
	}
	const evidence = `{"output_medium":"file","artifact_id":"opaque_file","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","page_count":1,"bytes":1000}`
	if err := q.UpdateTerminalResult("evidence-rejected", "success", "", "", "windows_spooler", evidence); err == nil {
		t.Fatal("terminal result carrying file evidence was accepted")
	}
	if _, status, found, err := q.Get("evidence-rejected"); err != nil || !found || status != "printing" {
		t.Fatalf("rejected evidence commit changed durable execution state: %s %v", status, err)
	}
}
