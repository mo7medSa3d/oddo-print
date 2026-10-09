package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
)

type attemptEvidencePrinter struct{ run func(context.Context) error }

func (p *attemptEvidencePrinter) Print(ctx context.Context, _ []byte) error { return p.run(ctx) }
func (*attemptEvidencePrinter) Test(context.Context) error                  { return nil }
func (*attemptEvidencePrinter) Status() string                              { return "unknown" }
func (*attemptEvidencePrinter) LastSpoolerJobID() string                    { return "654" }

func newEvidenceTestAgent(t *testing.T, p printer.Printer, id string) *Agent {
	t.Helper()
	ag := newTestAgent(t, "p1", p)
	if err := ag.queue.Push(id, "p1", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := ag.queue.BeginPrint(id, "p1", []byte("x"), "claim-"+id, false); err != nil {
		t.Fatal(err)
	}
	return ag
}

func TestAttemptEvidenceRejectsBackendHistory(t *testing.T) {
	for _, mode := range []string{"unsupported", "cancelled", "before-allocation"} {
		t.Run(mode, func(t *testing.T) {
			p := &attemptEvidencePrinter{run: func(ctx context.Context) error {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return errors.New("pre-allocation refusal")
			}}
			ag := newEvidenceTestAgent(t, p, "fresh")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			kind := printer.KindRaw
			if mode == "unsupported" {
				kind = printer.KindPDF
			}
			if mode == "cancelled" {
				cancel()
			}
			id, err := ag.dispatchDocumentWithEvidence(ctx, "fresh", p, printer.Document{Kind: kind, Data: []byte("x")})
			if err == nil || id != "" {
				t.Fatalf("rejected invocation inherited backend history: id=%q err=%v", id, err)
			}
			rows, err := ag.queue.MarkInterrupted()
			if err != nil || len(rows) != 1 || rows[0].SpoolerJobID != "" {
				t.Fatalf("old ID entered new printing row: %+v %v", rows, err)
			}
			if p.LastSpoolerJobID() != "654" {
				t.Fatal("fix erased old diagnostic history instead of isolating attempts")
			}
		})
	}
}

func TestAttemptEvidencePreservesOwnAllocationForEveryOutcome(t *testing.T) {
	for _, mode := range []string{"success", "failure", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			p := &attemptEvidencePrinter{run: func(ctx context.Context) error {
				printer.RecordSpoolerJobID(ctx, 852)
				if mode == "failure" {
					return errors.New("failure after allocation")
				}
				if mode == "unknown" {
					return printer.MarkUnknown("native worker still active")
				}
				return nil
			}}
			ag := newEvidenceTestAgent(t, p, "own")
			id, err := ag.dispatchDocumentWithEvidence(context.Background(), "own", p, printer.Document{Kind: printer.KindRaw, Data: []byte("x")})
			if id != "852" || ((err == nil) != (mode == "success")) {
				t.Fatalf("outcome/evidence changed: %q %v", id, err)
			}
			if mode == "unknown" && !printer.OutcomeUnknown(err) {
				t.Fatal("lost unknown classification")
			}
			rows, err := ag.queue.MarkInterrupted()
			if err != nil || len(rows) != 1 || rows[0].SpoolerJobID != "852" {
				t.Fatalf("mid-phase evidence lost: %+v %v", rows, err)
			}
		})
	}
}

func TestAttemptEvidenceLateWorkerCannotChangeNextInvocation(t *testing.T) {
	releaseOld, oldDone := make(chan struct{}), make(chan struct{})
	enteredNew, releaseNew := make(chan struct{}), make(chan struct{})
	var onceOld, onceNew sync.Once
	release := func() { onceOld.Do(func() { close(releaseOld) }); onceNew.Do(func() { close(releaseNew) }) }
	defer release()
	p := &attemptEvidencePrinter{run: func(ctx context.Context) error {
		go func() { defer close(oldDone); <-releaseOld; printer.RecordSpoolerJobID(ctx, 777) }()
		return printer.MarkUnknown("old worker still active before identity allocation")
	}}
	ag := newEvidenceTestAgent(t, p, "first")
	firstID, err := ag.dispatchDocumentWithEvidence(context.Background(), "first", p, printer.Document{Kind: printer.KindRaw})
	if firstID != "" || !printer.OutcomeUnknown(err) {
		t.Fatalf("first outcome %q %v", firstID, err)
	}
	if err := ag.queue.Push("second", "p1", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := ag.queue.BeginPrint("second", "p1", []byte("x"), "claim-second", false); err != nil {
		t.Fatal(err)
	}
	p.run = func(ctx context.Context) error {
		printer.RecordSpoolerJobID(ctx, 888)
		close(enteredNew)
		<-releaseNew
		return nil
	}
	result := make(chan string, 1)
	go func() {
		id, _ := ag.dispatchDocumentWithEvidence(context.Background(), "second", p, printer.Document{Kind: printer.KindRaw})
		result <- id
	}()
	select {
	case <-enteredNew:
	case <-time.After(2 * time.Second):
		t.Fatal("second invocation did not start")
	}
	onceOld.Do(func() { close(releaseOld) })
	select {
	case <-oldDone:
	case <-time.After(2 * time.Second):
		t.Fatal("old worker did not exit")
	}
	onceNew.Do(func() { close(releaseNew) })
	select {
	case id := <-result:
		if id != "888" {
			t.Fatalf("old worker contaminated new terminal ID %q", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second invocation did not exit")
	}
	rows, err := ag.queue.MarkInterrupted()
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, row := range rows {
		ids[row.ID] = row.SpoolerJobID
	}
	if len(ids) != 2 || ids["first"] != "" || ids["second"] != "888" {
		t.Fatalf("cross-attempt evidence: %+v", ids)
	}
}

func TestAttemptEvidencePanicStillJoinsObserver(t *testing.T) {
	p := &attemptEvidencePrinter{run: func(ctx context.Context) error { printer.RecordSpoolerJobID(ctx, 555); panic("native boundary panic") }}
	ag := newEvidenceTestAgent(t, p, "panic")
	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected panic to propagate to outer execution fence")
			}
		}()
		_, _ = ag.dispatchDocumentWithEvidence(context.Background(), "panic", p, printer.Document{Kind: printer.KindRaw})
	}()
	rows, err := ag.queue.MarkInterrupted()
	if err != nil || len(rows) != 1 || rows[0].SpoolerJobID != "555" {
		t.Fatalf("observer not joined on panic: %+v %v", rows, err)
	}
}
