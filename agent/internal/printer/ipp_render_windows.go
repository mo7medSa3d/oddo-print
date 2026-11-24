//go:build windows

package printer

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"

	"github.com/klippa-app/go-pdfium/requests"
)

// renderIPPPDFToJPEG converts a *single* PDF page before any network print
// submission. This fallback is used only if the printer explicitly reports
// image/jpeg in document-format-supported and does NOT report application/pdf.
//
// Multi-page PDF cannot be safely represented by one JPEG IPP Print-Job.
// A Windows spooler queue with an installed driver is needed instead of
// sending partial pages as separate jobs and risking duplicates.
func renderIPPPDFToJPEG(ctx context.Context, pdfData []byte, attrs map[string]string) ([]byte, error) {
	dpi, err := ippJPEGResolution(attrs)
	if err != nil {
		return nil, err
	}
	if err := ValidatePDF(pdfData); err != nil {
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
		return nil, fmt.Errorf("initialize embedded PDFium for IPP JPEG conversion: %w", err)
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire embedded PDFium worker: %w", err)
	}
	// jpegKilled records cancellation interrupts so the deferred Close does not
	// report the expected "already closed" state as a worker-cleanup failure.
	var jpegKilled pdfiumKillTracker
	defer func() { _ = jpegKilled.close(instance) }()

	head, err := openPDFDocumentHead(ctx, instance, pdfData, &jpegKilled)
	if err != nil {
		return nil, fmt.Errorf("open PDF for JPEG conversion: %w", err)
	}
	defer head.close()

	if head.pageCount != 1 {
		return nil, fmt.Errorf("JPEG IPP fallback needs exactly one PDF page (received %d); configure this printer as a Windows spooler queue for multiple pages", head.pageCount)
	}
	size := head.pageSizes[0]
	width, height, renderDPI, err := ippJPEGGeometry(size.width, size.height, maxPDFRenderPixels, dpi)
	if err != nil {
		return nil, err
	}
	img, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
		Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: head.document, Index: 0}},
		Width:  width,
		Height: height,
	}, &jpegKilled)
	if err != nil {
		return nil, fmt.Errorf("render PDF page to JPEG for IPP: %w", err)
	}
	if cleanup != nil {
		defer cleanup()
	}
	if img == nil {
		return nil, fmt.Errorf("PDFium returned an empty page")
	}
	// JPEG has no transparency. Composite PDFium's bitmap over white to avoid
	// black backgrounds on transparent PDF pages. PDFium's FPDFBitmap_BGRA
	// carries STRAIGHT (non-premultiplied) alpha, but Go's image.RGBA type is
	// defined as premultiplied — draw.Over on the raw value double-applies
	// alpha and washes transparents out. Wrap as NRGBA exactly as go-pdfium's
	// own renderer does so Over uses the straight-alpha formula.
	white := image.NewRGBA(img.Bounds())
	draw.Draw(white, white.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	straight := &image.NRGBA{Pix: img.Pix, Stride: img.Stride, Rect: img.Rect}
	draw.Draw(white, white.Bounds(), straight, straight.Bounds().Min, draw.Over)
	var output bytes.Buffer
	output.Grow(min(maxPrintBytes, max(64*1024, (width*height)/4)))
	// WP7: quality 95, not 88 — same measurement as receipt creation
	// (mean gray error 0.043 vs 0.115 at q88 on an anti-aliased fixture,
	// zero pixels deviating by more than 10 levels). The 5 MiB output
	// check below still fails closed if a page ever exceeds the budget.
	if err := jpeg.Encode(&output, white, &jpeg.Options{Quality: 95}); err != nil {
		return nil, fmt.Errorf("encode rendered IPP JPEG: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if output.Len() == 0 || output.Len() > maxPrintBytes {
		return nil, fmt.Errorf("IPP JPEG output %d bytes exceeds %d-byte print job limit", output.Len(), maxPrintBytes)
	}
	return wrapIPPPayloadAsJFIF(output.Bytes(), uint16(renderDPI))
}
