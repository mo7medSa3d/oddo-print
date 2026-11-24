package queue

import (
	"fmt"
	"path/filepath"
	"testing"
)

// Local durable-queue microbenchmarks.
//
// The SQLite-backed queue is written to at least once per job state
// transition (queued -> printing/BeginPrint -> success/failed). Push and the
// IsProcessed idempotency check are on the dispatch path, so their per-op cost
// matters when a burst of jobs arrives.
//
// Run with:
//
//	go test -bench=. -benchmem ./internal/queue/
//
// Note: this measures real SQLite commit cost on the local filesystem, so the
// numbers include disk fsync behaviour of the configured journal mode. It is
// therefore closer to a component benchmark than a pure CPU microbenchmark.

func newBenchQueue(b *testing.B) *Queue {
	b.Helper()
	q, err := New(filepath.Join(b.TempDir(), "bench.db"))
	if err != nil {
		b.Fatalf("New: %v", err)
	}
	b.Cleanup(func() { _ = q.Close() })
	return q
}

func BenchmarkQueuePush(b *testing.B) {
	q := newBenchQueue(b)
	payload := []byte("ESC/POS receipt payload of moderate size ................................")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		id := fmt.Sprintf("job_%d", i)
		if err := q.Push(id, "printer_1", payload); err != nil {
			b.Fatalf("Push: %v", err)
		}
	}
}

func BenchmarkQueueIsProcessed_Hit(b *testing.B) {
	q := newBenchQueue(b)
	id := "job_processed"
	if err := q.Push(id, "printer_1", []byte("x")); err != nil {
		b.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus(id, "printing"); err != nil {
		b.Fatalf("UpdateStatus: %v", err)
	}
	if err := q.UpdateStatus(id, "success"); err != nil {
		b.Fatalf("UpdateStatus: %v", err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = q.IsProcessed(id)
	}
}

func BenchmarkQueueIsProcessed_Miss(b *testing.B) {
	q := newBenchQueue(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = q.IsProcessed("nonexistent")
	}
}

// Full lifecycle transition cost: queued -> printing -> success, the common
// happy path for one job.
func BenchmarkQueueLifecycle(b *testing.B) {
	q := newBenchQueue(b)
	payload := []byte("payload")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		id := fmt.Sprintf("life_%d", i)
		if err := q.Push(id, "printer_1", payload); err != nil {
			b.Fatalf("Push: %v", err)
		}
		if err := q.UpdateStatus(id, "printing"); err != nil {
			b.Fatalf("UpdateStatus printing: %v", err)
		}
		if err := q.UpdateStatus(id, "success"); err != nil {
			b.Fatalf("UpdateStatus success: %v", err)
		}
	}
}
