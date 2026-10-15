//go:build windows

package printer

import (
	"context"
	"fmt"
)

func (p *SpoolerPrinter) PrintTestPage(ctx context.Context) error {
	return p.printTestPageWithPaper(ctx, func() (float64, float64, error) {
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
	var width, height float64
	if err := p.boundedPreflight(ctx, preflightTimeout, func() error {
		var err error
		width, height, err = currentPaper()
		return err
	}); err != nil {
		return fmt.Errorf("read current Windows test-page paper: %w", err)
	}
	data, err := diagnosticTestPDF(width, height)
	if err != nil {
		return err
	}
	return p.PrintDocument(ctx, Document{Kind: KindPDF, Data: data, JobID: "local-test"})
}
