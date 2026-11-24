package printer

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestSerializedUnknownOutcomeSurvivesWrapping(t *testing.T) {
	for _, marker := range []string{
		"AGENT_EXECUTION_TIMEOUT",
		"AGENT_RESTART_DURING_PRINT",
		"JOB_EXPIRED_DURING_PRINT",
		"UNKNOWN_PARTIAL_DELIVERY",
		"UNKNOWN_SUBMISSION_OUTCOME",
	} {
		t.Run(marker, func(t *testing.T) {
			cause := errors.New(marker + ": printer completion unavailable")
			for _, err := range []error{
				fmt.Errorf("document transport: %w", cause),
				errors.Join(errors.New("cleanup failed"), fmt.Errorf("renderer: %w", cause)),
				fmt.Errorf("document transport: %w", MarkUnknown("%s", cause)),
			} {
				if !OutcomeUnknown(err) {
					t.Fatalf("wrapped physical uncertainty became retryable: %v", err)
				}
			}
		})
	}
}

func TestOutcomeUnknownDoesNotTreatIncidentalMarkerTextAsEvidence(t *testing.T) {
	for _, err := range []error{
		errors.New("printer named UNKNOWN_PARTIAL_DELIVERY is unavailable"),
		fmt.Errorf("dispatch: %w", context.Canceled),
		errors.Join(errors.New("printer UNKNOWN_SUBMISSION_OUTCOME is unavailable"), context.DeadlineExceeded),
	} {
		if OutcomeUnknown(err) {
			t.Fatalf("incidental marker text became physical-outcome evidence: %v", err)
		}
	}
}

func TestPDFResultWrapperPreservesSerializedUnknownOutcome(t *testing.T) {
	jobID, err := printPDFWithResult(context.Background(), "Receipt Queue", Document{
		Kind: KindPDF, Data: validPDF(), JobID: "unknown-result-fixture",
	}, func(context.Context, string, string) (string, error) {
		return "42", errors.New("UNKNOWN_PARTIAL_DELIVERY: native completion failed")
	})
	if jobID != "42" || err == nil || !OutcomeUnknown(err) {
		t.Fatalf("PDF wrapper lost native ambiguity or job identity: id=%q error=%v", jobID, err)
	}
}
