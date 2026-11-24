//go:build windows

package printer

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

func awaitSpoolerWorkerExit(t *testing.T, p *SpoolerPrinter) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for p.SessionMayBeLive() {
		if time.Now().After(deadline) {
			t.Fatal("spooler worker did not release liveness after boundary returned")
		}
		time.Sleep(time.Millisecond)
	}
	if !p.sessionMu.TryLock() {
		t.Fatal("liveness cleared before session lock cleanup")
	}
	p.sessionMu.Unlock()
}

func TestSpoolerPDFLivenessOutlivesCancelledCaller(t *testing.T) {
	for _, mode := range []string{"legacy", "result", "platform"} {
		t.Run(mode, func(t *testing.T) {
			oldGrace, oldPlatform := postCancelSpoolerResultGrace, platformPrintPDFObserved
			postCancelSpoolerResultGrace = 5 * time.Millisecond
			p := NewSpooler("Liveness PDF Queue", "")
			started, release := make(chan string, 1), make(chan struct{})
			var releaseOnce sync.Once
			finish := func() { releaseOnce.Do(func() { close(release) }) }
			defer func() {
				finish()
				// Join by the actual session mutex too: the baseline has no
				// PDF liveness counter and must not leave a test worker alive.
				deadline := time.Now().Add(2 * time.Second)
				for {
					if p.sessionMu.TryLock() {
						p.sessionMu.Unlock()
						break
					}
					if time.Now().After(deadline) {
						t.Error("PDF boundary failed to exit")
						break
					}
					time.Sleep(time.Millisecond)
				}
				// No hook reads occur after the worker releases its session.
				postCancelSpoolerResultGrace, platformPrintPDFObserved = oldGrace, oldPlatform
			}()
			block := func(_ context.Context, _ string, path string) (string, error) {
				started <- path
				<-release
				return "812", nil
			}
			switch mode {
			case "legacy":
				p.PDFPrint = func(ctx context.Context, name, path string) error { _, err := block(ctx, name, path); return err }
			case "result":
				p.PDFPrintResult = block
			default:
				platformPrintPDFObserved = func(ctx context.Context, name, path string, onJobID func(uint32)) (string, error) {
					onJobID(812)
					return block(ctx, name, path)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() {
				result <- p.printPDFDocument(ctx, Document{Kind: KindPDF, Data: validPDF(), JobID: "liveness"})
			}()
			var tempPath string
			select {
			case tempPath = <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("PDF worker never reached boundary")
			}
			cancel()
			select {
			case err := <-result:
				if !OutcomeUnknown(err) {
					t.Fatalf("cancelled live PDF must be UNKNOWN, got %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("PDF caller was not bounded")
			}
			if !p.SessionMayBeLive() {
				t.Fatal("PDF timeout dropped generation fence while worker could still print")
			}
			if _, err := os.Stat(tempPath); err != nil {
				t.Fatalf("live PDF worker lost its temporary input: %v", err)
			}
			if mode == "platform" && p.LastSpoolerJobID() != "812" {
				t.Fatal("early native job identity was lost")
			}
			waiting, stop := context.WithTimeout(context.Background(), 5*time.Millisecond)
			err := p.printPDFDocument(waiting, Document{Kind: KindPDF, Data: validPDF()})
			stop()
			if !errors.Is(err, context.DeadlineExceeded) || OutcomeUnknown(err) {
				t.Fatalf("waiting caller must fail before submission, got %v", err)
			}
			if !p.SessionMayBeLive() {
				t.Fatal("waiting caller cleared first worker liveness")
			}
			other := NewSpooler("Independent PDF Queue", "")
			other.PDFPrintResult = func(context.Context, string, string) (string, error) { return "813", nil }
			if err := other.printPDFDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()}); err != nil {
				t.Fatalf("unrelated queue blocked: %v", err)
			}
			awaitSpoolerWorkerExit(t, other)
			finish()
			awaitSpoolerWorkerExit(t, p)
			if _, err := os.Stat(tempPath); !os.IsNotExist(err) {
				t.Fatalf("completed PDF left temporary input: %v", err)
			}
		})
	}
}

func TestSpoolerRAWLivenessOutlivesCancelledCaller(t *testing.T) {
	withFakeQueue(t, 0, 0)
	oldSession, oldGrace := currentExecuteSpoolerSession, postCancelSpoolerResultGrace
	postCancelSpoolerResultGrace = 5 * time.Millisecond
	p := NewSpooler("Liveness RAW Queue", "")
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	finish := func() { releaseOnce.Do(func() { close(release) }) }
	defer func() {
		finish()
		awaitSpoolerWorkerExit(t, p)
		currentExecuteSpoolerSession, postCancelSpoolerResultGrace = oldSession, oldGrace
	}()
	currentExecuteSpoolerSession = func(_ string, data []byte, _ <-chan struct{}, onJobID func(uintptr), _ ...func() error) spoolerTaskResult {
		onJobID(814)
		close(started)
		<-release
		return spoolerTaskResult{jobID: 814, written: uint32(len(data))}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- p.Print(ctx, []byte("raw liveness")) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("RAW worker never reached boundary")
	}
	cancel()
	select {
	case err := <-result:
		if !OutcomeUnknown(err) {
			t.Fatalf("cancelled live RAW must be UNKNOWN, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RAW caller was not bounded")
	}
	if !p.SessionMayBeLive() || p.LastSpoolerJobID() != "814" {
		t.Fatal("RAW caller dropped worker ownership/evidence")
	}
	finish()
	awaitSpoolerWorkerExit(t, p)
}

func TestSpoolerPDFFailureReleasesLiveness(t *testing.T) {
	p := NewSpooler("Failure Queue", "")
	p.PDFPrintResult = func(context.Context, string, string) (string, error) {
		return "", errors.New("native pre-submission failure")
	}
	if err := p.printPDFDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()}); err == nil || OutcomeUnknown(err) {
		t.Fatalf("expected definite failure, got %v", err)
	}
	awaitSpoolerWorkerExit(t, p)
}
