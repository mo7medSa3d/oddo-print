package printer

import (
	"context"
	"strconv"
	"sync"
)

type spoolerEvidenceKey struct{}

// SpoolerJobEvidence belongs to one dispatch invocation, not to a reusable
// backend or Gateway job ID. A retry must receive a fresh instance. An allocated
// platform ID is reconciliation evidence, never proof of physical completion.
type SpoolerJobEvidence struct {
	mu     sync.Mutex
	jobID  string
	closed bool
}

// WithSpoolerJobEvidence starts a fresh observation scope. Cancellation does not
// erase evidence: a synchronous native allocation may complete after cancel.
func WithSpoolerJobEvidence(ctx context.Context) (context.Context, *SpoolerJobEvidence) {
	evidence := &SpoolerJobEvidence{}
	return context.WithValue(ctx, spoolerEvidenceKey{}, evidence), evidence
}

// RecordSpoolerJobID publishes an allocation from the native worker using the
// context captured for that exact invocation. Callers without an observer keep
// their existing diagnostic behavior. One dispatch owns one native document;
// the first nonzero allocation remains its identity, including on failure.
func RecordSpoolerJobID(ctx context.Context, jobID uint64) {
	if jobID == 0 {
		return
	}
	evidence, _ := ctx.Value(spoolerEvidenceKey{}).(*SpoolerJobEvidence)
	if evidence == nil {
		return
	}
	evidence.mu.Lock()
	defer evidence.mu.Unlock()
	if !evidence.closed && evidence.jobID == "" {
		evidence.jobID = strconv.FormatUint(jobID, 10)
	}
}

// SpoolerJobID returns only this dispatch's allocation, never backend history.
func (e *SpoolerJobEvidence) SpoolerJobID() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.jobID
}

// Close freezes the terminal snapshot. A worker that outlives its caller must
// not rewrite this snapshot or a subsequent dispatch's evidence. Its unresolved
// physical outcome remains UNKNOWN; a missing ID does not authorize retry.
func (e *SpoolerJobEvidence) Close() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closed = true
	return e.jobID
}
