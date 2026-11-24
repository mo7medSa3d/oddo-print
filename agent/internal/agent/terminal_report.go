package agent

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/queue"
)

// reportDurableTerminalResult re-reports a terminal result persisted in
// the local queue outbox (for example after a lost Gateway
// acknowledgement) WITHOUT re-running printer I/O. The retained claim
// token is the execution identity being reconciled.
func (a *Agent) reportDurableTerminalResult(ctx context.Context, report queue.TerminalReport) error {
	if report.ClaimToken == "" {
		return fmt.Errorf("terminal result has no retained execution claim; explicit reconciliation is required")
	}
	var submission *printer.SubmissionEvidence
	if report.Status == "success" {
		ev := printer.VerifySubmission(ctx, nil)
		ev.Transport = report.Transport
		ev.SpoolerJobID = report.SpoolerJobID
		submission = &ev
	}
	err := a.updateJobStatusWithSubmissionEvidence(ctx, report.ID, report.Status, report.LastError, report.ClaimToken,
		report.SpoolerJobID, report.Transport, submission)
	if err != nil && (errors.Is(err, ErrJobCanceled) || errors.Is(err, ErrStaleClaim)) {
		// The server has already settled this job (canceled, expired, or
		// reconciled under another claim). No re-report for this token can
		// ever succeed, so keeping it in the pending outbox would retry
		// forever. Clearing the local claim token drops it from the pending
		// set WITHOUT re-running printer I/O; the local terminal row
		// (status + error) is retained for forensics.
		log.Printf("Job %s: server settled job (%v); dropping terminal re-report (no reprint)", report.ID, err)
		if clearErr := a.queue.ClearClaimToken(report.ID, report.ClaimToken); clearErr != nil {
			log.Printf("Job %s: could not clear settled terminal report token: %v", report.ID, clearErr)
			return err
		}
		return nil
	}
	return err
}
