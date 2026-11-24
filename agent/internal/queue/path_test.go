package queue

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestQueueOpensTheExactValidatedFilesystemPath(t *testing.T) {
	for _, name := range []string{"queue.db", "queue #1%.db", "queue?draft.db", "queue?cache=shared&unused=.db"} {
		t.Run(name, func(t *testing.T) {
			if runtime.GOOS == "windows" && (name == "queue?draft.db" || name == "queue?cache=shared&unused=.db") {
				t.Skip("Windows forbids question marks in filenames")
			}
			path := filepath.Join(t.TempDir(), name)
			q, err := New(path)
			if err != nil {
				t.Fatal(err)
			}
			defer q.Close()
			var sequence int
			var database, openedPath string
			if err := q.db.QueryRow("PRAGMA database_list").Scan(&sequence, &database, &openedPath); err != nil {
				t.Fatal(err)
			}
			validated, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := os.Stat(openedPath)
			if err != nil {
				t.Fatal(err)
			}
			if !os.SameFile(validated, opened) {
				t.Fatalf("SQLite opened %q instead of the permission-checked path %q", openedPath, path)
			}
			if err := q.Push("durable-job", "printer", []byte("receipt")); err != nil {
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
			_, _, found, err := q.Get("durable-job")
			if err != nil || !found {
				t.Fatalf("queue ledger did not survive reopen: found=%v error=%v", found, err)
			}
		})
	}
}

func TestQueueMemoryDatabaseRemainsSupported(t *testing.T) {
	q, err := New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if err := q.Push("memory-job", "printer", []byte("receipt")); err != nil {
		t.Fatal(err)
	}
	_, _, found, err := q.Get("memory-job")
	if err != nil || !found {
		t.Fatalf("in-memory queue unavailable: found=%v error=%v", found, err)
	}
}
