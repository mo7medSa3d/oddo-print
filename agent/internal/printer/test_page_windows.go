//go:build windows

package printer

import (
	"context"
	"fmt"
)

func (p *SpoolerPrinter) PrintTestPage(ctx context.Context) error {
	return p.printNativeTestPage(ctx, "local-test")
}

// Both the local CLI and Gateway test_page jobs select the CURRENT printer
// driver paper before physical submission. Never guess a printer language or
// nominal width from the printer's display name.
func (p *SpoolerPrinter) printNativeTestPage(ctx context.Context, jobID string) error {
	if p.diagnosticPaper != nil {
		return p.printTestPageWithPaperForJob(ctx, jobID, p.diagnosticPaper)
	}
	return p.printTestPageWithPaperForJob(ctx, jobID, func() (float64, float64, error) {
		// Win32 DC acquisition, caps and DeleteDC own one OS thread.
		unlock := pinGDIPrintThread()
		defer unlock()
		mode, err := pdfPrinterCurrentDevMode(p.SpoolerName)
		if err != nil {
			return 0, 0, err
		}
		hdc, err := openPrinterDC(p.SpoolerName, mode)
		if err != nil {
			return 0, 0, err
		}
		defer procDeleteDC.Call(hdc)
		w, h := deviceCaps(hdc, capPhysicalWidth), deviceCaps(hdc, capPhysicalHeight)
		dpiX, dpiY := deviceCaps(hdc, capLogPixelsX), deviceCaps(hdc, capLogPixelsY)
		if w <= 0 || h <= 0 || dpiX <= 0 || dpiY <= 0 {
			return 0, 0, fmt.Errorf("printer returned invalid test-page media")
		}
		return float64(w) * 72 / float64(dpiX), float64(h) * 72 / float64(dpiY), nil
	})
}

func (p *SpoolerPrinter) printTestPageWithPaper(ctx context.Context, currentPaper func() (float64, float64, error)) error {
	return p.printTestPageWithPaperForJob(ctx, "local-test", currentPaper)
}

func (p *SpoolerPrinter) printTestPageWithPaperForJob(ctx context.Context, jobID string, currentPaper func() (float64, float64, error)) error {
	var width, height float64
	if err := p.boundedPreflight(ctx, preflightTimeout, func() error {
		var err error
		width, height, err = currentPaper()
		return err
	}); err != nil {
		return fmt.Errorf("read current Windows test-page paper: %w", err)
	}
	width, height, err := boundedDiagnosticPaper(width, height)
	if err != nil {
		return fmt.Errorf("selected Windows test media cannot produce a safe diagnostic: %w", err)
	}
	data, err := diagnosticTestPDF(width, height)
	if err != nil {
		return err
	}
	// No recursion: this is now an ordinary PDF. The existing GDI workflow
	// owns StartDocW, spooler evidence and UNKNOWN/no-auto-retry semantics.
	return p.PrintDocument(ctx, Document{Kind: KindPDF, Data: data, JobID: jobID})
}
