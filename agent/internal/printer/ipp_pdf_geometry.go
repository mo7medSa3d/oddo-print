package printer

import (
	"context"
	"fmt"
	"math"

	"github.com/klippa-app/go-pdfium/requests"
)

type ippPDFPage struct{ WidthPoints, HeightPoints float64 }

// Read actual PDFium page geometry before submission, not a regex or header
// guess. Metadata inspection releases the single worker before rasterization.
func inspectIPPPDFPages(ctx context.Context, data []byte) ([]ippPDFPage, error) {
	return inspectBoundedPDFPages(ctx, data, maxPrintBytes)
}

// Generated file output shares the same actual PDFium page inspection. Only
// its encoded byte budget differs; ordinary submitted PDFs retain their limit.
func inspectBoundedPDFPages(ctx context.Context, data []byte, byteLimit int) ([]ippPDFPage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validatePDFBounded(data, byteLimit); err != nil {
		return nil, err
	}
	select {
	case embeddedPDFPrintSlot <- struct{}{}:
		defer func() { <-embeddedPDFPrintSlot }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	pool, err := getPDFiumPoolWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("initialize PDF geometry inspector: %w", err)
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire PDF geometry inspector: %w", err)
	}
	var killed pdfiumKillTracker
	defer func() { _ = killed.close(instance) }()
	type inspection struct {
		pages         []ippPDFPage
		closeDocument func()
	}
	release := func(r inspection) {
		if r.closeDocument != nil && !killed.killed {
			r.closeDocument()
		}
	}
	result, err := awaitPDFRenderResult(ctx, func() (inspection, error) {
		var r inspection
		doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
		if err != nil {
			return r, fmt.Errorf("open PDF for media negotiation: %w", err)
		}
		r.closeDocument = func() { _, _ = instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document}) }
		count, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
		if err != nil || count == nil || count.PageCount < 1 || count.PageCount > maxPDFPages {
			return r, fmt.Errorf("invalid PDF page count for media negotiation: %v", err)
		}
		r.pages = make([]ippPDFPage, 0, count.PageCount)
		for page := 0; page < count.PageCount; page++ {
			if err := ctx.Err(); err != nil {
				return r, err
			}
			size, err := instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc.Document, Index: page})
			if err != nil || size == nil || size.Width <= 0 || size.Height <= 0 || math.IsNaN(size.Width) || math.IsNaN(size.Height) || math.IsInf(size.Width, 0) || math.IsInf(size.Height, 0) || size.Width > 10000*72/25.4 || size.Height > 10000*72/25.4 {
				return r, fmt.Errorf("invalid or excessive PDF media on page %d", page+1)
			}
			r.pages = append(r.pages, ippPDFPage{size.Width, size.Height})
		}
		return r, nil
	}, release, func() { killed.kill(instance) })
	if err != nil {
		return nil, err
	}
	defer release(result)
	return result.pages, nil
}
