package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/testutil"
)

// TestCrashWindowSimulation calls the raw transport directly twice to show
// why the Agent/Gateway must fence uncertain physical outcomes. It does not
// execute an Agent crash, queue recovery, Gateway reclaim or physical printer.
// Production recovery forbids a second dispatch for an unknown prior outcome.
func TestCrashWindowSimulation(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.Start()
	defer mock.Close()

	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx := context.Background()
	data := []byte("crash-window payload")

	// Step 1: bytes accepted (print succeeds at transport)
	if err := p.Print(ctx, data); err != nil {
		t.Fatalf("Print: %v", err)
	}
	caps := mock.WaitForCaptures(1, 5*time.Second)
	if len(caps) != 1 || string(caps[0]) != string(data) {
		t.Fatalf("capture failed %v", caps)
	}

	// Step 2: deliberately call the transport again outside the Agent safeguards.
	// The wire duplicates bytes; this is the hazard guarded by the actual queue
	// and Agent policy tests, including when legacy reprint_after_crash is true.
	if err := p.Print(ctx, data); err != nil {
		t.Fatalf("re-print after crash reclaim: %v", err)
	}
	caps2 := mock.WaitForCaptures(2, 5*time.Second)
	if len(caps2) != 2 {
		t.Fatalf("expected 2 captures after reclaim (duplicate), got %d", len(caps2))
	}
	// Document: both captures identical → duplicate physical print possible.
	if string(caps2[0]) != string(data) || string(caps2[1]) != string(data) {
		t.Fatalf("duplicate captures mismatch")
	}
}

func TestCrashWindowWithIdempotentSuccessGuard(t *testing.T) {
	// If agent had reached queue.UpdateStatus success before crash, second delivery should be suppressed via IsProcessed.
	// This test documents the guard: after success, duplicate Print should NOT happen.
	// Here we just prove mock alone has no guard — guard lives in queue.IsProcessed, not mock.
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.Start()
	defer mock.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx := context.Background()
	mockData := []byte("idempotent")
	p.Print(ctx, mockData)
	p.Print(ctx, mockData) // without queue guard, this WILL duplicate at wire level
	caps := mock.WaitForCaptures(2, 5*time.Second)
	if len(caps) != 2 {
		t.Fatalf("without queue guard, duplicate at wire level is 2, got %d", len(caps))
	}
	// Real agent would call IsProcessed(jobID) and skip second Print — see agent/agent_test.go TestDuplicateSkippedAfterSuccess
}
