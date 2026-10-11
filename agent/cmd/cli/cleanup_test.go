package main

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/queue"
)

func TestParseCleanupArgsSupportsLeadingAndTrailingGlobalFlags(t *testing.T) {
	want := filepath.Join(t.TempDir(), "agent.yaml")
	cases := []struct {
		name       string
		args       []string
		matched    bool
		jsonOutput bool
		include    bool
		wantConfig string
	}{
		{"trailing flags", []string{"jobs", "cleanup", "--json", "--include-unknown", "--config", want}, true, true, true, want},
		{"leading config", []string{"--config", want, "jobs", "cleanup", "--json"}, true, true, false, want},
		{"legacy no flags", []string{"jobs", "cleanup"}, true, false, false, ""},
		{"not cleanup", []string{"jobs", "list"}, false, false, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotConfig, gotJSON, gotInclude, gotMatch, err := parseCleanupArgs(tc.args)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gotMatch != tc.matched || gotJSON != tc.jsonOutput || gotInclude != tc.include {
				t.Fatalf("got match=%v json=%v include=%v", gotMatch, gotJSON, gotInclude)
			}
			if tc.wantConfig != "" && gotConfig != tc.wantConfig {
				t.Fatalf("got config %q want %q", gotConfig, tc.wantConfig)
			}
		})
	}
}

func TestParseCleanupArgsRejectsMissingConfigValue(t *testing.T) {
	_, _, _, matched, err := parseCleanupArgs([]string{"jobs", "cleanup", "--config"})
	if !matched || err == nil {
		t.Fatalf("expected matched cleanup command with a config-value error")
	}
}

func TestCleanupJobsIncludeUnknownKeepsPendingGatewayReports(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.db")
	q, err := queue.New(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.BeginPrint("unacknowledged", "printer-1", []byte("x"), "live-claim", false); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatusWithError("unacknowledged", "failed", "UNKNOWN_SUBMISSION_OUTCOME: receipt may have printed"); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	deleted, purged, kept, err := cleanupJobs(path, true)
	if err != nil || deleted != 0 || purged != 0 || kept != 1 {
		t.Fatalf("cleanupJobs deleted=%d purged=%d kept=%d err=%v; must keep the pending report", deleted, purged, kept, err)
	}
	reopened, err := queue.New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reports, err := reopened.PendingTerminalReports(10)
	if err != nil || len(reports) != 1 || reports[0].ClaimToken != "live-claim" {
		t.Fatalf("outbox evidence lost after manual cleanup: %+v err=%v", reports, err)
	}
}

// Cleanup can irreversibly remove reconciled unknown physical outcomes.
// Unsupported flags must NEVER be silently ignored on this command.
func TestParseCleanupArgsRejectsUnknownCleanupFlagsAndExtraArgs(t *testing.T) {
	cases := [][]string{
		{"jobs", "cleanup", "--dry-run", "--include-unknown"},
		{"--config", "agent.yml", "jobs", "cleanup", "extra"},
		{"jobs", "cleanup", "--config", "--json"},
		{"jobs", "cleanup", "--config", "one", "--config", "two"},
	}
	for _, args := range cases {
		_, _, _, matched, err := parseCleanupArgs(args)
		if !matched || err == nil {
			t.Errorf("parseCleanupArgs(%v) must refuse destructive cleanup with unsupported arguments", args)
		}
	}
}

// A config flag value must not be mistaken for the command itself.
func TestParseCleanupArgsDoesNotTreatConfigPathAsCommand(t *testing.T) {
	_, _, _, matched, err := parseCleanupArgs([]string{"--config", "jobs", "cleanup"})
	if matched || err != nil {
		t.Fatalf("config value incorrectly parsed as a maintenance command: matched=%t err=%v", matched, err)
	}
}

// --include-unknown may purge ACKNOWLEDGED evidence, but must report pending
// delivery reports still kept in the local outbox rather than showing zero.
func TestCleanupJobsMixedAcknowledgementReportsAccurately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.db")
	q, err := queue.New(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"pending", "acknowledged"} {
		if err := q.BeginPrint(id, "printer-1", []byte("receipt"), "claim-"+id, false); err != nil {
			t.Fatal(err)
		}
		if err := q.UpdateStatusWithError(id, "failed", "UNKNOWN_PARTIAL_DELIVERY: outcome uncertain"); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.ClearClaimToken("acknowledged", "claim-acknowledged"); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	deleted, purged, kept, err := cleanupJobs(path, true)
	if err != nil || deleted != 0 || purged != 1 || kept != 1 {
		t.Fatalf("cleanupJobs deleted=%d purged=%d kept=%d err=%v; expected 1 ACK purged, 1 pending retained", deleted, purged, kept, err)
	}
}
