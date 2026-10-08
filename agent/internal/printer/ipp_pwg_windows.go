//go:build windows

package printer

import (
	"bytes"
	"context"
	"fmt"
	"math"

	"github.com/klippa-app/go-pdfium/requests"
)

// renderIPPPDFToPWG produces a COMPLETE multi-page PWG Raster v2 document
// before a single IPP Print-Job leaves the Agent. The caller has already
// verified that image/pwg-raster is supported by this printer URI.
// Never submit partially-rendered pages or retry ambiguous IPP responses.
func renderIPPPDFToPWG(ctx context.Context, pdfData []byte, attrs map[string]string) ([]byte, error) {
	if err := ValidatePDF(pdfData); err != nil {
		return nil, err
	}
	dpi, color, err := pwgOptionsFromIPPAttributes(attrs)
	if err != nil {
		return nil, err
	}
	select {
	case embeddedPDFPrintSlot <- struct{}{}:
		defer func() { <-embeddedPDFPrintSlot }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	pool, err := getPDFiumPool()
	if err != nil {
		return nil, fmt.Errorf("initialize embedded PDFium for PWG Raster: %w", err)
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire embedded PDFium worker: %w", err)
	}
	defer func() { _ = instance.Close() }()
	pdf, err := instance.OpenDocument(&requests.OpenDocument{File: &pdfData})
	if err != nil {
		return nil, fmt.Errorf("open PDF for PWG Raster: %w", err)
	}
	defer func() { _, _ = instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: pdf.Document}) }()

	pages, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: pdf.Document})
	if err != nil || pages == nil || pages.PageCount < 1 || pages.PageCount > maxPDFPages {
		return nil, fmt.Errorf("invalid PWG Raster PDF page count: %v (%v)", pages, err)
	}
	var result bytes.Buffer
	result.WriteString("RaS2")
	for page := 0; page < pages.PageCount; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		size, err := instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{
			Document: pdf.Document,
			Index:    page,
		})
		if err != nil || size == nil || !(size.Width > 0 && size.Height > 0) ||
			math.IsNaN(size.Width) || math.IsNaN(size.Height) ||
			math.IsInf(size.Width, 0) || math.IsInf(size.Height, 0) {
			return nil, fmt.Errorf("PDF page %d: invalid paper dimensions: %v", page+1, err)
		}
		w := math.Round(size.Width * float64(dpi) / 72.0)
		h := math.Round(size.Height * float64(dpi) / 72.0)
		if w <= 0 || h <= 0 || w > 32767 || h > 32767 {
			return nil, fmt.Errorf("PDF page %d exceeds PWG page dimension bounds", page+1)
		}
		if w*h > float64(maxPDFRasterPixels) {
			// Lowering resolution while declaring original DPI would distort
			// paper geometry. Fail before sending anything instead.
			return nil, fmt.Errorf("PDF page %d at supported %ddpi exceeds the %d-pixel PWG render limit; configure a Windows spooler queue for large-format printing", page+1, dpi, maxPDFRasterPixels)
		}
		img, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
			Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: pdf.Document, Index: page}},
			Width:  int(w),
			Height: int(h),
		})
		if err != nil {
			return nil, fmt.Errorf("render PDF page %d to PWG Raster: %w", page+1, err)
		}
		if img == nil {
			if cleanup != nil {
				cleanup()
			}
			return nil, fmt.Errorf("PDFium returned no bitmap for page %d", page+1)
		}
		encodeErr := encodePWGPage(&result, img, dpi, pages.PageCount, size.Width, size.Height, color)
		if cleanup != nil {
			cleanup()
		}
		if encodeErr != nil {
			return nil, fmt.Errorf("encode PWG Raster page %d: %w", page+1, encodeErr)
		}
	}
	if result.Len() > maxPrintBytes {
		return nil, fmt.Errorf("PWG Raster output %d bytes exceeds %d-byte limit", result.Len(), maxPrintBytes)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}
