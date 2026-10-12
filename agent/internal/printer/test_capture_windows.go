//go:build windows

package printer

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"math"

	"github.com/klippa-app/go-pdfium/requests"
)

// renderLocalPDFPreview uses the same headless-safe embedded PDFium worker as
// physical PDF jobs but NEVER calls OpenPrinter, StartDoc, EndDoc, GDI, or IPP.
// Every page is decoded, while only page one is returned as a visual preview.
func renderLocalPDFPreview(ctx context.Context, data []byte) ([]byte, int, error) {
	select {
	case embeddedPDFPrintSlot <- struct{}{}:
		defer func() { <-embeddedPDFPrintSlot }()
	case <-ctx.Done():
		return nil, 0, ctx.Err()
	}
	pool, err := getPDFiumPool()
	if err != nil {
		return nil, 0, err
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return nil, 0, err
	}
	var killed pdfiumKillTracker
	defer killed.close(instance)

	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return nil, 0, fmt.Errorf("open document: %w", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	pages, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return nil, 0, err
	}
	if pages.PageCount < 1 || pages.PageCount > 10 {
		return nil, 0, fmt.Errorf("test PDFs must have between 1 and 10 pages")
	}

	var preview []byte
	for index := 0; index < pages.PageCount; index++ {
		if err := ctx.Err(); err != nil {
			return nil, 0, err
		}
		size, err := instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc.Document, Index: index})
		if err != nil || size == nil || size.Width <= 0 || size.Height <= 0 ||
			math.IsNaN(size.Width) || math.IsNaN(size.Height) ||
			math.IsInf(size.Width, 0) || math.IsInf(size.Height, 0) {
			return nil, 0, fmt.Errorf("invalid PDF page %d geometry: %v", index+1, err)
		}
		scale := math.Min(800/size.Width, 1500/size.Height)
		if scale <= 0 {
			return nil, 0, fmt.Errorf("invalid PDF render scale")
		}
		width := int(math.Max(1, math.Round(size.Width*scale)))
		height := int(math.Max(1, math.Round(size.Height*scale)))
		picture, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
			Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: index}},
			Width:  width,
			Height: height,
		}, &killed)
		if err != nil {
			return nil, 0, fmt.Errorf("render page %d: %w", index+1, err)
		}
		if picture == nil {
			if cleanup != nil {
				cleanup()
			}
			return nil, 0, fmt.Errorf("PDFium returned no image for page %d", index+1)
		}
		if index == 0 {
			var encoded bytes.Buffer
			err = png.Encode(&encoded, picture)
			if err == nil {
				if encoded.Len() > 2*1024*1024 {
					err = fmt.Errorf("preview exceeds 2 MiB limit")
				} else {
					preview = encoded.Bytes()
				}
			}
		}
		if cleanup != nil {
			cleanup()
		}
		if err != nil {
			return nil, 0, err
		}
	}
	return preview, pages.PageCount, nil
}
