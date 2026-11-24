package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
)

// Deliberately has no operational-verification implementation.
type unverifiedPrinter struct{ target *fakePrinter }

func (p *unverifiedPrinter) Print(ctx context.Context, data []byte) error {
	return p.target.Print(ctx, data)
}
func (p *unverifiedPrinter) Test(context.Context) error { return nil }
func (p *unverifiedPrinter) Status() string             { return "online" }

func TestV3HeartbeatCannotReplayConfiguredOperationalProof(t *testing.T) {
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": &unverifiedPrinter{target: &fakePrinter{}}})
	pc := a.printerConfigs["p"]
	pc.Capabilities["operational_verification"] = map[string]interface{}{
		"version": 1, "verified_at": time.Now().UTC().Format(time.RFC3339),
		"printer_id": "p", "method": "windows_queue",
	}
	a.printerConfigs["p"] = pc
	entry := heartbeatEntry(t, a.printerStatusPayload(), "p")
	if entry["capabilities"].(map[string]interface{})["operational_verification"] != nil {
		t.Fatal("configured text became fresh live operational proof in heartbeat")
	}
}

// Policy (operator directive): operational verification is background
// evidence, never a print gate. A backend that cannot produce a live
// existence proof — e.g. a driver whose measurement is slow or failing —
// still receives production bytes; the physical attempt itself reports
// real device errors. This test replaces the former hard-gate contract
// (TestV3UnverifiedBackendCannotReceiveProductionBytes).
func TestV3UnverifiedBackendStillReceivesProductionBytes(t *testing.T) {
	physical := &fakePrinter{}
	a := newTestAgent(t, "p", &unverifiedPrinter{target: physical})
	a.processJob(context.Background(), map[string]interface{}{
		"id": "unverified-operation", "agentId": "agt_test", "printerId": "p",
		"status": "claimed", "claimToken": "claim-unverified-operation",
		"payload":   makeJobPayload("unverified-operation"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339), "bindingDigest": testDefaultPrinterBinding(),
	})
	a.waitForJobs()
	if physical.Calls() != 1 {
		t.Fatal("a backend without an operational-verification proof must still receive production bytes; verification is advisory only")
	}
}

func TestV3ClaimCannotChangeItsAdmittedDestination(t *testing.T) {
	// A job carrying a VALID binding digest that provably differs from the
	// current destination must still be refused: the destination changed
	// after admission, which is a real configuration error, not a
	// measurement problem.
	t.Run("binding-mismatch", func(t *testing.T) {
		physical := &fakePrinter{}
		a := newTestAgent(t, "p", physical)
		job := dispatchTestJob("binding-destination", "p")
		job["bindingDigest"] = strings.Repeat("a", 64)
		a.processJob(context.Background(), job)
		if physical.Calls() != 0 {
			t.Fatal("a provably different admission binding delivered bytes to the current configured destination")
		}
	})
	// A job carrying NO binding (e.g. admitted for a printer that has
	// never verified, so the Gateway had no digest to bind) must NOT be
	// refused: there is no provable destination change, and verification
	// absence is advisory only.
	t.Run("binding-absent", func(t *testing.T) {
		physical := &fakePrinter{}
		a := newTestAgent(t, "p", physical)
		job := dispatchTestJob("binding-destination", "p")
		delete(job, "bindingDigest")
		a.processJob(context.Background(), job)
		if physical.Calls() != 1 {
			t.Fatal("a job with no admission binding must still print; a missing binding is not a provable destination change")
		}
	})
}
