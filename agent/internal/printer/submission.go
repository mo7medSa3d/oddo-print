package printer

import (
	"context"
	"strings"
	"time"
)

// WP2 (v4): spooler-submission evidence and its classification —
// STATIC REVIEW ONLY.
//
// This file is the agent-side mirror of src/lib/submission-evidence.ts.
// The rule table MUST stay identical on both sides (see the v4 WP1-WP2
// report's parity section); the Gateway re-derives the state from the
// stored fields and never trusts the agent's label.
//
// States:
//   - "submitted": spooler/IPP accepted the job, physical output
//     unverified. This is the ONLY state a submission-time report may
//     carry: acceptance is not verification.
//   - "completed": a post-submission query verified spooler completion
//     (Windows JOB_STATUS_PRINTED, or IPP job-state completed (9)
//     without error reasons). Spooler confirmation, NOT paper proof.
//   - "unknown": verification failed, timed out, or returned a
//     terminal-bad state. Never a silent success, never an auto-reprint.
//
// Windows JOB_INFO Status flag values (Winspool.h, JOB_INFO_1 Status
// member). JOB_STATUS_COMPLETE means "sent to the printer, but the job
// may not be printed yet" and must NEVER upgrade to completed; only
// JOB_STATUS_PRINTED ("job has printed", spooler-side) upgrades.
const (
	WindowsJobStatusPaused           uint32 = 0x00000001
	WindowsJobStatusError            uint32 = 0x00000002
	WindowsJobStatusDeleting         uint32 = 0x00000004
	WindowsJobStatusSpooling         uint32 = 0x00000008
	WindowsJobStatusPrinting         uint32 = 0x00000010
	WindowsJobStatusOffline          uint32 = 0x00000020
	WindowsJobStatusPaperOut         uint32 = 0x00000040
	WindowsJobStatusPrinted          uint32 = 0x00000080
	WindowsJobStatusDeleted          uint32 = 0x00000100
	WindowsJobStatusBlockedDevQ      uint32 = 0x00000200
	WindowsJobStatusUserIntervention uint32 = 0x00000400
	WindowsJobStatusRestart          uint32 = 0x00000800
	WindowsJobStatusComplete         uint32 = 0x00001000
	WindowsJobStatusRetained         uint32 = 0x00002000
)

// WindowsJobFlagNames converts a JOB_INFO Status bitmask to the
// Gateway's allowlisted flag NAME list (see validateSubmissionEvidence).
// Unknown bits are dropped, never invented: a flag the Gateway does not
// know cannot upgrade a job.
func WindowsJobFlagNames(status uint32) []string {
	var names []string
	for _, flag := range []struct {
		bit  uint32
		name string
	}{
		{WindowsJobStatusPaused, "PAUSED"},
		{WindowsJobStatusError, "ERROR"},
		{WindowsJobStatusDeleting, "DELETING"},
		{WindowsJobStatusSpooling, "SPOOLING"},
		{WindowsJobStatusPrinting, "PRINTING"},
		{WindowsJobStatusOffline, "OFFLINE"},
		{WindowsJobStatusPaperOut, "PAPEROUT"},
		{WindowsJobStatusPrinted, "PRINTED"},
		{WindowsJobStatusDeleted, "DELETED"},
		{WindowsJobStatusBlockedDevQ, "BLOCKED_DEVQ"},
		{WindowsJobStatusUserIntervention, "USER_INTERVENTION"},
		{WindowsJobStatusRestart, "RESTART"},
		{WindowsJobStatusComplete, "COMPLETE"},
		{WindowsJobStatusRetained, "RETAINED"},
	} {
		if status&flag.bit != 0 {
			names = append(names, flag.name)
		}
	}
	return names
}

// IPP job-state values (RFC 8011 section 5.3.7 / RFC 8010).
const (
	IPPJobStatePending           int32 = 3
	IPPJobStatePendingHeld       int32 = 4
	IPPJobStateProcessing        int32 = 5
	IPPJobStateProcessingStopped int32 = 6
	IPPJobStateCanceled          int32 = 7
	IPPJobStateAborted           int32 = 8
	IPPJobStateCompleted         int32 = 9
)

// SubmissionEvidence is the wire shape the Gateway validates (see
// validateSubmissionEvidence key allowlist). JSON tags match the
// Gateway field names exactly.
type SubmissionEvidence struct {
	Transport           string   `json:"transport,omitempty"`
	SpoolerJobID        string   `json:"spoolerJobId,omitempty"`
	WindowsJobStatus    []string `json:"windowsJobStatus,omitempty"`
	PagesPrinted        *int     `json:"pagesPrinted,omitempty"`
	IPPJobState         *int32   `json:"ippJobState,omitempty"`
	IPPJobStateReasons  []string `json:"ippJobStateReasons,omitempty"`
	SheetsCompleted     *int     `json:"sheetsCompleted,omitempty"`
	VerificationSource  string   `json:"verificationSource,omitempty"`
	VerificationAttempt string   `json:"verificationAttempt,omitempty"`
}

func hasIPPErrorReason(reasons []string) bool {
	for _, r := range reasons {
		if r == "completed-with-errors" || r == "job-canceled-at-device" ||
			r == "job-canceled-by-user" || r == "job-canceled-by-operator" ||
			strings.HasPrefix(r, "aborted-by-system") {
			return true
		}
	}
	return false
}

func hasWindowsErrorFlag(flags []string) bool {
	for _, f := range flags {
		switch f {
		case "ERROR", "PAPEROUT", "OFFLINE", "USER_INTERVENTION", "BLOCKED_DEVQ", "DELETED", "DELETING":
			return true
		}
	}
	return false
}

// ClassifySubmission derives the WP2 submission state from evidence
// fields only — never from a caller-supplied label. It mirrors
// deriveSubmissionState in src/lib/submission-evidence.ts.
func ClassifySubmission(ev SubmissionEvidence) string {
	if ev.VerificationSource != "query" {
		return "submitted"
	}
	if ev.VerificationAttempt == "unknown" || ev.VerificationAttempt == "timeout" {
		return "unknown"
	}
	if ev.IPPJobState != nil && (*ev.IPPJobState == IPPJobStateCanceled || *ev.IPPJobState == IPPJobStateAborted) {
		return "unknown"
	}
	if hasIPPErrorReason(ev.IPPJobStateReasons) {
		return "unknown"
	}
	if hasWindowsErrorFlag(ev.WindowsJobStatus) {
		return "unknown"
	}
	for _, f := range ev.WindowsJobStatus {
		if f == "PRINTED" {
			return "completed"
		}
	}
	if ev.IPPJobState != nil && *ev.IPPJobState == IPPJobStateCompleted {
		return "completed"
	}
	return "submitted"
}

// Verification bounds (WP2). The verifier runs synchronously inside the
// job's own worker goroutine: it spawns NO goroutines, so it cannot leak
// them, and it can never block the claim loop beyond its total budget
// (4 attempts x 3s per-attempt timeout + 1s/2s/4s backoff = 19s worst
// case, less when the query answers or the context is canceled).
const (
	submissionVerifyMaxAttempts    = 4
	submissionVerifyAttemptTimeout = 3 * time.Second
)

var submissionVerifyBackoff = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}

// SubmissionQuery is a single post-submission spooler/IPP query: it
// returns the query evidence for one attempt, or an error (including a
// "job not found" result, which the caller reports as unknown, never as
// proof of no print). Platform adapters plug in here when they exist;
// v4 ships no live GetJob/Get-Job-Attributes adapter (see the WP1-WP2
// report: no such hook exists in the tree and writing uncompiled Win32
// query code would be unverifiable), so callers pass nil until one lands.
type SubmissionQuery func(ctx context.Context) (SubmissionEvidence, error)

// VerifySubmission runs the bounded verification step. With a nil query
// it returns submission-source evidence immediately (verification
// unavailable): the job still reports success, but the Gateway derives
// 'submitted', never 'completed'. A query that errors, times out, or
// finds nothing returns verificationAttempt "unknown" — never success,
// never a reprint trigger. Terminal query results (completed or unknown)
// stop the loop early; intermediate states (still spooling/processing)
// are retried until the attempt budget is spent, then report "submitted"
// with the last observed evidence (the spooler may still finish the job
// after the report; the Gateway row stays 'success' either way).
func VerifySubmission(ctx context.Context, query SubmissionQuery) SubmissionEvidence {
	if query == nil {
		return SubmissionEvidence{VerificationSource: "submission", VerificationAttempt: "unavailable"}
	}
	var last SubmissionEvidence
	for attempt := 0; attempt < submissionVerifyMaxAttempts; attempt++ {
		if attempt > 0 {
			backoff := submissionVerifyBackoff[attempt-1]
			select {
			case <-ctx.Done():
				last.VerificationSource = "query"
				last.VerificationAttempt = "timeout"
				return last
			case <-time.After(backoff):
			}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, submissionVerifyAttemptTimeout)
		ev, err := query(attemptCtx)
		cancel()
		if err != nil {
			last = SubmissionEvidence{VerificationSource: "query", VerificationAttempt: "unknown"}
			if ctx.Err() != nil {
				last.VerificationAttempt = "timeout"
				return last
			}
			continue
		}
		ev.VerificationSource = "query"
		if ev.VerificationAttempt == "" {
			ev.VerificationAttempt = "submitted"
		}
		last = ev
		state := ClassifySubmission(ev)
		if state == "completed" || state == "unknown" {
			return last
		}
	}
	if last.VerificationAttempt == "" {
		last.VerificationAttempt = "submitted"
	}
	last.VerificationSource = "query"
	return last
}
