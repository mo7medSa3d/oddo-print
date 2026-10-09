//go:build windows

package printer

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRawEvidenceStaysWithWorkerAcrossBusyAttempt(t *testing.T) {
	withFakeQueue(t, 0, 0)
	oldExecute, oldGrace := currentExecuteSpoolerSession, postCancelSpoolerResultGrace
	postCancelSpoolerResultGrace = 5 * time.Millisecond
	p := NewSpooler("Evidence RAW", "")
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	defer func() {
		finish()
		awaitSpoolerWorkerExit(t, p)
		currentExecuteSpoolerSession = oldExecute
		postCancelSpoolerResultGrace = oldGrace
	}()
	currentExecuteSpoolerSession = func(_ string, _ []byte, _ <-chan struct{}, onID func(uintptr), _ ...func() error) spoolerTaskResult {
		onID(321)
		close(started)
		<-release
		onID(321)
		return spoolerTaskResult{jobID: 321, err: errors.New("late failure")}
	}
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx, first := WithSpoolerJobEvidence(base)
	result := make(chan error, 1)
	go func() { result <- p.Print(ctx, []byte("x")) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("worker not started")
	}
	if first.SpoolerJobID() != "321" {
		t.Fatal("early native allocation missing")
	}
	cancel()
	select {
	case err := <-result:
		if !OutcomeUnknown(err) {
			t.Fatalf("blocked worker not unknown: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("caller did not return")
	}
	if first.Close() != "321" {
		t.Fatal("lost own native identity")
	}
	busyBase, cancelBusy := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancelBusy()
	busyCtx, busy := WithSpoolerJobEvidence(busyBase)
	if err := p.Print(busyCtx, []byte("y")); err == nil {
		t.Fatal("overlapping caller acquired live native session")
	}
	if busy.Close() != "" || p.LastSpoolerJobID() != "321" {
		t.Fatal("busy caller adopted or erased prior worker evidence")
	}
	finish()
	awaitSpoolerWorkerExit(t, p)
	currentExecuteSpoolerSession = func(_ string, _ []byte, _ <-chan struct{}, onID func(uintptr), _ ...func() error) spoolerTaskResult {
		onID(987)
		return spoolerTaskResult{jobID: 987, written: 1}
	}
	nextCtx, next := WithSpoolerJobEvidence(context.Background())
	if err := p.Print(nextCtx, []byte("z")); err != nil {
		t.Fatal(err)
	}
	awaitSpoolerWorkerExit(t, p)
	if next.Close() != "987" || first.SpoolerJobID() != "321" || busy.SpoolerJobID() != "" {
		t.Fatal("worker scopes crossed during reuse")
	}
}

func TestRawResultOnlyAllocationIsPublishedByWorker(t *testing.T) {
	withFakeQueue(t, 0, 0)
	old := currentExecuteSpoolerSession
	p := NewSpooler("RAW result evidence", "")
	defer func() { awaitSpoolerWorkerExit(t, p); currentExecuteSpoolerSession = old }()
	currentExecuteSpoolerSession = func(string, []byte, <-chan struct{}, func(uintptr), ...func() error) spoolerTaskResult {
		return spoolerTaskResult{jobID: 456, err: errors.New("enddoc failed")}
	}
	ctx, evidence := WithSpoolerJobEvidence(context.Background())
	if err := p.Print(ctx, []byte("x")); err == nil {
		t.Fatal("expected failure after allocation")
	}
	if evidence.Close() != "456" {
		t.Fatal("result-only worker allocation lost")
	}
}

func TestPDFEvidenceStaysWithWorkerAcrossBusyAttempt(t *testing.T) {
	for _, mode := range []string{"platform", "result", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			oldPlatform, oldGrace := platformPrintPDFObserved, postCancelSpoolerResultGrace
			postCancelSpoolerResultGrace = 5 * time.Millisecond
			p := NewSpooler("Evidence PDF", "")
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			finish := func() { once.Do(func() { close(release) }) }
			defer func() {
				finish()
				awaitSpoolerWorkerExit(t, p)
				platformPrintPDFObserved = oldPlatform
				postCancelSpoolerResultGrace = oldGrace
			}()
			block := func(context.Context, string, string) (string, error) { close(started); <-release; return "812", nil }
			expected := ""
			switch mode {
			case "platform":
				expected = "812"
				platformPrintPDFObserved = func(ctx context.Context, name, path string, onID func(uint32)) (string, error) {
					onID(812)
					return block(ctx, name, path)
				}
			case "result":
				p.PDFPrintResult = block
			default:
				p.PDFPrint = func(ctx context.Context, name, path string) error { _, err := block(ctx, name, path); return err }
			}
			base, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx, first := WithSpoolerJobEvidence(base)
			result := make(chan error, 1)
			go func() { result <- p.printPDFDocument(ctx, Document{Kind: KindPDF, Data: validPDF()}) }()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("PDF worker did not start")
			}
			cancel()
			select {
			case err := <-result:
				if !OutcomeUnknown(err) {
					t.Fatalf("blocked PDF not unknown: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("PDF caller did not return")
			}
			if first.Close() != expected {
				t.Fatalf("wrong current allocation: got %q expected %q", first.SpoolerJobID(), expected)
			}
			busyBase, cancelBusy := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancelBusy()
			busyCtx, busy := WithSpoolerJobEvidence(busyBase)
			if err := p.printPDFDocument(busyCtx, Document{Kind: KindPDF, Data: validPDF()}); err == nil {
				t.Fatal("second PDF overlapped live worker")
			}
			if busy.Close() != "" {
				t.Fatal("second PDF inherited previous allocation")
			}
			finish()
			awaitSpoolerWorkerExit(t, p)
			if first.SpoolerJobID() != expected || busy.SpoolerJobID() != "" {
				t.Fatal("late native result changed frozen snapshot")
			}
			p.PDFPrint = nil
			p.PDFPrintResult = func(context.Context, string, string) (string, error) { return "893", nil }
			nextCtx, next := WithSpoolerJobEvidence(context.Background())
			if err := p.printPDFDocument(nextCtx, Document{Kind: KindPDF, Data: validPDF()}); err != nil {
				t.Fatal(err)
			}
			awaitSpoolerWorkerExit(t, p)
			if next.Close() != "893" || first.SpoolerJobID() != expected {
				t.Fatal("reuse crossed evidence scopes")
			}
		})
	}
}
