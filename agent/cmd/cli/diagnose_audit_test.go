package main

import (
	"context"
	"github.com/yaseir-agent/agent/internal/printer"
	"testing"
	"time"
)

func TestDiagnosticSpoolerTimeoutDoesNotAccumulateBlockedRPCs(t *testing.T) {
	blocked := make(chan struct{})
	started := make(chan struct{})
	defer close(blocked)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := probeSpoolerDiagnostic(ctx, "blocked", func(name string) printer.SpoolerProbe {
		close(started)
		<-blocked
		return printer.SpoolerProbe{QueueName: name, Verdict: printer.SpoolerReadyToAccept}
	})
	<-started
	if result.Verdict != printer.SpoolerStatusUnknown {
		t.Fatalf("timeout became readiness: %+v", result)
	}
	called := false
	second := probeSpoolerDiagnostic(context.Background(), "another", func(name string) printer.SpoolerProbe { called = true; return printer.SpoolerProbe{} })
	if called || second.Verdict != printer.SpoolerStatusUnknown {
		t.Fatal("spawned a second RPC behind stalled Windows call")
	}
}
