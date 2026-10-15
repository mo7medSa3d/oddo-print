//go:build windows

package printer

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestWindowsLocalPrintSubmitsActualCurrentPaperPDF(t *testing.T) {
	p := NewSpooler("Selected Windows Queue", "")
	submitted := 0
	p.PDFPrint = func(ctx context.Context, queue, path string) error {
		submitted++
		if queue != p.SpoolerName {
			t.Fatalf("diagnostic substituted a queue: %q", queue)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Contains(data, []byte("/MediaBox [0 0 204.38 283.75]")) || !bytes.Contains(data, []byte("YASEIR PRINT TEST")) {
			t.Fatalf("diagnostic lost actual72.1mm media or content: %q", data)
		}
		return ValidatePDF(data)
	}
	if err := p.printTestPageWithPaper(context.Background(), func() (float64, float64, error) { return 72.1 * 72 / 25.4, 100.1 * 72 / 25.4, nil }); err != nil || submitted != 1 {
		t.Fatalf("local test only probed readiness: submitted=%d err=%v", submitted, err)
	}
}

func TestWindowsLocalPrintDoesNotSubmitAfterMediaFailure(t *testing.T) {
	p := NewSpooler("Unavailable Test Queue", "")
	submitted := false
	p.PDFPrint = func(context.Context, string, string) error { submitted = true; return nil }
	refused := errors.New("driver media unavailable")
	err := p.printTestPageWithPaper(context.Background(), func() (float64, float64, error) { return 0, 0, refused })
	if !errors.Is(err, refused) || submitted || OutcomeUnknown(err) {
		t.Fatalf("failed native media probe submitted a diagnostic: %v submitted=%v", err, submitted)
	}
}

func TestWindowsGeneratedDiagnosticIsRenderedByRealPDFium(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	for _, width := range []float64{612, 58 * 72 / 25.4, 72.1 * 72 / 25.4} {
		data, err := diagnosticTestPDF(width, 100*72/25.4)
		if err != nil {
			t.Fatal(err)
		}
		capture, err := CaptureTestDocument(ctx, data, "pdf", 0)
		if err != nil || capture.Pages != 1 || len(capture.PreviewPNG) == 0 {
			t.Fatalf("generated diagnostic could not render: width=%g pages=%d err=%v", width, capture.Pages, err)
		}
	}
}
