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
	"math"

	"github.com/klippa-app/go-pdfium/requests"
)

// renderIPPPDFToJPEG converts a *single* PDF page before any network print
// submission. This fallback is used only if the printer explicitly reports
// image/jpeg in document-format-supported and does NOT report application/pdf.
//
// Multi-page PDF cannot be safely represented by one JPEG IPP Print-Job.
// A Windows spooler queue with an installed driver is needed instead of
// sending partial pages as separate jobs and risking duplicates.
func renderIPPPDFToJPEG(ctx context.Context, pdfData []byte) ([]byte, error) {
	if err := ValidatePDF(pdfData); err != nil {
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
		return nil, fmt.Errorf("initialize embedded PDFium for IPP JPEG conversion: %w", err)
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire embedded PDFium worker: %w", err)
	}
	defer func() { _ = instance.Close() }()

	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &pdfData})
	if err != nil {
		return nil, fmt.Errorf("open PDF for JPEG conversion: %w", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	pages, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return nil, fmt.Errorf("read PDF page count: %w", err)
	}
	if pages.PageCount != 1 {
		return nil, fmt.Errorf("JPEG IPP fallback needs exactly one PDF page (received %d); configure this printer as a Windows spooler queue for multiple pages", pages.PageCount)
	}
	size, err := instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc.Document, Index: 0})
	if err != nil || size == nil {
		return nil, fmt.Errorf("read PDF page dimensions: %v", err)
	}
	if !(size.Width > 0 && size.Height > 0) || math.IsNaN(size.Width) || math.IsNaN(size.Height) || math.IsInf(size.Width, 0) || math.IsInf(size.Height, 0) {
		return nil, fmt.Errorf("invalid PDF page dimensions")
	}
	// Render at ~200 dpi for legible test pages and barcodes, capped to the
	// same bounded rendering budget as the Windows GDI PDF pipeline.
	w, h := size.Width*(200.0/72.0), size.Height*(200.0/72.0)
	if w < 1 || h < 1 {
		return nil, fmt.Errorf("PDF page dimensions are too small")
	}
	area := w * h
	if area > float64(maxPDFRenderPixels) {
		scale := math.Sqrt(float64(maxPDFRenderPixels) / area)
		w, h = w*scale, h*scale
	}
	if w > 32767 || h > 32767 {
		return nil, fmt.Errorf("PDF page dimensions exceed JPEG renderer bounds")
	}
	width, height := int(math.Round(w)), int(math.Round(h))
	if width <= 0 || height <= 0 || int64(width)*int64(height) > maxPDFRenderPixels {
		return nil, fmt.Errorf("PDF render exceeds %d pixel budget", maxPDFRenderPixels)
	}
	img, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
		Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: 0}},
		Width:  width,
		Height: height,
	})
	if err != nil {
		return nil, fmt.Errorf("render PDF page to JPEG for IPP: %w", err)
	}
	if cleanup != nil {
		defer cleanup()
	}
	if img == nil {
		return nil, fmt.Errorf("PDFium returned an empty page")
	}
	// JPEG has no transparency. Composite PDFium's RGBA over white to avoid
	// black backgrounds on transparent PDF pages.
	white := image.NewRGBA(img.Bounds())
	draw.Draw(white, white.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(white, white.Bounds(), img, img.Bounds().Min, draw.Over)
	var output bytes.Buffer
	if err := jpeg.Encode(&output, white, &jpeg.Options{Quality: 88}); err != nil {
		return nil, fmt.Errorf("encode rendered IPP JPEG: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if output.Len() == 0 || output.Len() > maxPrintBytes {
		return nil, fmt.Errorf("IPP JPEG output %d bytes exceeds %d-byte print job limit", output.Len(), maxPrintBytes)
	}
	return wrapIPPPayloadAsJFIF(output.Bytes(), 200)
}
