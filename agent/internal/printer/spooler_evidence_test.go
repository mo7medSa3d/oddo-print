package printer

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestSpoolerEvidenceDoesNotInheritParentOrBackendHistory(t *testing.T) {
	parent, old := WithSpoolerJobEvidence(context.Background())
	RecordSpoolerJobID(parent, 111)
	ctx, fresh := WithSpoolerJobEvidence(parent)
	RecordSpoolerJobID(ctx, 0)
	if got := fresh.SpoolerJobID(); got != "" {
		t.Fatalf("new scope inherited %q", got)
	}
	RecordSpoolerJobID(ctx, 222)
	RecordSpoolerJobID(ctx, 333)
	if fresh.Close() != "222" || old.Close() != "111" {
		t.Fatal("invocation evidence crossed scopes or changed allocation")
	}
}

func TestSpoolerEvidenceCloseRejectsLateAllocation(t *testing.T) {
	ctx, evidence := WithSpoolerJobEvidence(context.Background())
	if evidence.Close() != "" {
		t.Fatal("empty scope contains evidence")
	}
	RecordSpoolerJobID(ctx, 123)
	if evidence.Close() != "" {
		t.Fatal("late worker changed frozen terminal snapshot")
	}
	RecordSpoolerJobID(context.Background(), 123) // local diagnostics without observer
}

func TestSpoolerEvidencePreservesCancellationAndAdmission(t *testing.T) {
	base, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	admitted := false
	base = WithDispatchAdmission(base, func(context.Context) error { admitted = true; return nil })
	ctx, evidence := WithSpoolerJobEvidence(base)
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > time.Minute {
		t.Fatal("lost caller deadline")
	}
	if err := runDispatchAdmission(ctx); err != nil || !admitted {
		t.Fatal("lost dispatch authority")
	}
	cancel()
	if ctx.Err() == nil {
		t.Fatal("lost caller cancellation")
	}
	RecordSpoolerJobID(ctx, 456) // StartDoc can return after cancellation.
	if evidence.Close() != "456" {
		t.Fatal("cancellation erased actual native allocation")
	}
}

func TestSpoolerEvidenceConcurrentPublishAndClose(t *testing.T) {
	for i := 0; i < 64; i++ {
		ctx, evidence := WithSpoolerJobEvidence(context.Background())
		var wg sync.WaitGroup
		for j := 1; j <= 8; j++ {
			wg.Add(1)
			go func(n int) { defer wg.Done(); RecordSpoolerJobID(ctx, uint64(n)); _ = evidence.SpoolerJobID() }(j)
		}
		frozen := evidence.Close()
		wg.Wait()
		if evidence.SpoolerJobID() != frozen {
			t.Fatal("evidence changed after close")
		}
		if frozen != "" {
			n, err := strconv.Atoi(frozen)
			if err != nil || n < 1 || n > 8 {
				t.Fatalf("invalid allocation %q", frozen)
			}
		}
	}
}
