package queue

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// Old queue databases may predate the status CHECK. Opening a table with
// CREATE TABLE IF NOT EXISTS does not install the CHECK on an existing table.
// The Go helpers must validate statuses even when SQLite does not.
func TestLegacyQueueWithoutStatusCheckRejectsInvalidWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-queue.db")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE print_jobs (
		id TEXT PRIMARY KEY, printer_id TEXT NOT NULL, payload BLOB NOT NULL,
		status TEXT NOT NULL, retries INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	q, err := New(path)
	if err != nil {
		t.Fatalf("open legacy SQLite queue: %v", err)
	}
	defer q.Close()
	var ddl string
	if err := q.db.QueryRow(`SELECT sql FROM sqlite_master WHERE name='print_jobs'`).Scan(&ddl); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToUpper(ddl), "CHECK(") {
		t.Fatal("fixture accidentally acquired a CHECK constraint")
	}
	if err := q.Push("legacy-status", "p1", []byte("receipt")); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"claimed", "expired", "not-a-status", ""} {
		if err := q.UpdateStatus("legacy-status", status); err == nil {
			t.Fatalf("UpdateStatus accepted invalid status %q on legacy db", status)
		}
		if err := q.UpdateStatusWithError("legacy-status", status, "test"); err == nil {
			t.Fatalf("UpdateStatusWithError accepted invalid status %q on legacy db", status)
		}
		if err := q.UpdateTerminalWithEvidence("legacy-status", status, "test", ""); err == nil {
			t.Fatalf("UpdateTerminalWithEvidence accepted invalid status %q", status)
		}
	}
	_, status, exists, err := q.Get("legacy-status")
	if err != nil || !exists || status != "queued" {
		t.Fatalf("invalid writes altered legacy job: exists=%t status=%q err=%v", exists, status, err)
	}
	if err := q.UpdateStatusWithError("legacy-status", "printing", ""); err != nil {
		t.Fatalf("valid local status rejected on legacy table: %v", err)
	}
}
