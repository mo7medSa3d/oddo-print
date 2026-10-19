package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
)

// Full-module regression: actual processJob -> SQLite terminal outbox -> HTTP
// status payload. Unlike the portable projection this requires locked project
// dependencies, and must not be counted as executed by the isolated harness.
func TestProcessJobDoesNotAttributePreviousSpoolerIdentity(t *testing.T) {
	for _, mode := range []string{"pre-allocation-failure", "current-allocation-failure"} {
		t.Run(mode, func(t *testing.T) {
			gw := newRecordingGateway(t)
			gw.failTerminalOnce = true
			expected := ""
			if mode == "current-allocation-failure" {
				expected = "852"
			}
			p := &attemptEvidencePrinter{run: func(ctx context.Context) error {
				if expected != "" {
					printer.RecordSpoolerJobID(ctx, 852)
				}
				return errors.New("native transport refusal")
			}}
			ag := newAgentAgainst(t, gw.server.URL, "p1", p)
			id := "job-attempt-" + mode
			ag.processJob(context.Background(), map[string]interface{}{
				"id": id, "agentId": "agt_test", "printerId": "p1", "status": "claimed",
				"payload": makeJobPayload(id), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339), "claimToken": "claim-" + id,
			})
			ag.waitForJobs()
			reports, err := ag.queue.PendingTerminalReports(8)
			if err != nil || len(reports) != 1 || reports[0].Status != "failed" || reports[0].SpoolerJobID != expected {
				t.Fatalf("terminal outbox has wrong attempt identity: %+v %v", reports, err)
			}
			found := false
			for _, update := range gw.Updates() {
				if update.JobID == id && update.Status == "failed" {
					found = true
					if update.SpoolerJobID != expected {
						t.Fatalf("HTTP status carries wrong attempt evidence: %+v", update)
					}
				}
			}
			if !found {
				t.Fatal("missing terminal HTTP status")
			}
		})
	}
}
