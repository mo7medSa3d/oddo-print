package printer

import (
	"context"
	"testing"
	"time"
)

func TestDocumentContextUsesKindSpecificTimeout(t *testing.T) {
	parent := context.Background()

	pdfCtx, pdfCancel := documentContext(parent, KindPDF)
	defer pdfCancel()
	pdfDeadline, ok := pdfCtx.Deadline()
	if !ok {
		t.Fatal("PDF context must have a deadline")
	}
	pdfRemaining := time.Until(pdfDeadline)
	if pdfRemaining < 110*time.Second || pdfRemaining > 121*time.Second {
		t.Fatalf("PDF timeout should be about 120s, got %s", pdfRemaining)
	}

	rawCtx, rawCancel := documentContext(parent, KindRaw)
	defer rawCancel()
	rawDeadline, ok := rawCtx.Deadline()
	if !ok {
		t.Fatal("RAW context must have a deadline")
	}
	rawRemaining := time.Until(rawDeadline)
	if rawRemaining < 15*time.Second || rawRemaining > 21*time.Second {
		t.Fatalf("RAW timeout should be about 20s, got %s", rawRemaining)
	}
}

func TestDocumentContextPDFHonorsLargerParentDeadline(t *testing.T) {
	// A large deliberate caller budget (multi-hundred-KB raster on a slow
	// spooler) must never be clamped down to the 120s PDF default: cutting
	// a legitimate long write mid-payload produces garbage plus an unknown
	// outcome.
	parent, parentCancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer parentCancel()

	pdfCtx, pdfCancel := documentContext(parent, KindPDF)
	defer pdfCancel()
	deadline, ok := pdfCtx.Deadline()
	if !ok {
		t.Fatal("PDF context must have a deadline")
	}
	remaining := time.Until(deadline)
	if remaining < 9*time.Minute || remaining > 10*time.Minute {
		t.Fatalf("PDF context must preserve the larger parent budget, got %s remaining", remaining)
	}
}

func TestPDFDocumentContextPreservesShortDeadlineAndCancellation(t *testing.T) {
	parent, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	child, childCancel := documentContext(parent, KindPDF)
	defer childCancel()
	want, _ := parent.Deadline()
	got, ok := child.Deadline()
	if !ok || !got.Equal(want) {
		t.Fatalf("PDF changed explicit caller deadline: %v want %v", got, want)
	}
	cancel()
	if child.Err() != context.Canceled {
		t.Fatalf("PDF ignored cancellation: %v", child.Err())
	}
}
