//go:build windows

package printer

import (
	"bytes"
	"context"
	"errors"
	"image/jpeg"
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

func TestWindowsGatewayPDFTestUsesCurrentNativeRollAndLeavesCustomerPDFUntouched(t *testing.T) {
	p := NewSpooler("POS80 Printer(4)", "")
	p.diagnosticPaper = func() (float64, float64, error) {
		return 640 * 72.0 / 203, 26200 * 72.0 / 203, nil
	}
	submitted := 0
	p.PDFPrint = func(ctx context.Context, queue, path string) error {
		submitted++
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if queue != p.SpoolerName || !bytes.Contains(data, []byte("/MediaBox [0 0 227.00 283.46]")) ||
			!bytes.Contains(data, []byte("YASEIR PRINT TEST")) ||
			bytes.Contains(data, []byte("/MediaBox [0 0 612 792]")) {
			t.Errorf("wrong current-media diagnostic generated: %q", data)
		}
		return ValidatePDF(data)
	}
	if err := p.PrintDocument(context.Background(), Document{
		Kind: KindPDF, Data: validPDF(), JobID: "gateway-unique-job", TestPage: true,
	}); err != nil || submitted != 1 {
		t.Fatalf("Gateway native diagnostic not submitted once: calls=%d err=%v", submitted, err)
	}
	p.PDFPrint = func(ctx context.Context, queue, path string) error {
		submitted++
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, validPDF()) {
			t.Errorf("ordinary customer PDF was replaced by a test ticket")
		}
		return nil
	}
	if err := p.PrintDocument(context.Background(), Document{
		Kind: KindPDF, Data: validPDF(), JobID: "sale-order",
	}); err != nil || submitted != 2 {
		t.Fatalf("ordinary PDF path changed: calls=%d err=%v", submitted, err)
	}
}

func TestWindowsGatewayTestRejectsMalformedPreviewBeforeNativeProbe(t *testing.T) {
	p := NewSpooler("selected", "")
	probed, submitted := false, false
	p.diagnosticPaper = func() (float64, float64, error) { probed = true; return 612, 792, nil }
	p.PDFPrint = func(context.Context, string, string) error { submitted = true; return nil }
	err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: []byte("not a PDF"), TestPage: true})
	if err == nil || probed || submitted {
		t.Fatalf("invalid Gateway PDF triggered printing: probed=%v submitted=%v err=%v", probed, submitted, err)
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
		// Exercise the retained production PDFium rasterizer, not the retired
		// E2E capture API. Decode the complete image to catch broken bitmaps.
		rendered, err := renderIPPPDFToJPEG(ctx, data, map[string]string{"printer-resolution-supported": "200x200dpi"})
		if err != nil {
			t.Fatalf("generated diagnostic could not render: width=%g err=%v", width, err)
		}
		img, err := jpeg.Decode(bytes.NewReader(rendered))
		if err != nil || img.Bounds().Dx() <= 0 || img.Bounds().Dy() <= 0 {
			t.Fatalf("generated diagnostic rendered invalid JPEG: width=%g err=%v", width, err)
		}
	}
}
