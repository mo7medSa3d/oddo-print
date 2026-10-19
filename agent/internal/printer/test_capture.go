package printer

import (
	"context"
	"fmt"
)

// LocalCapture is a printer-free, offline artifact. It never enters discovery,
// the Agent queue, a Windows spooler, or Gateway/Odoo job accounting.
type LocalCapture struct {
	PDF        []byte
	PreviewPNG []byte
	Pages      int
}

const MaxLocalCaptureInput = 4 * 1024 * 1024

// CaptureTestDocument exercises the production JPEG-to-PDF receipt mapping
// and the embedded PDFium rendering engine, without admitting a print job.
// format must be jpeg or pdf; paperMM is only meaningful for receipt JPEGs.
func CaptureTestDocument(ctx context.Context, data []byte, format string, paperMM int) (LocalCapture, error) {
	if err := ctx.Err(); err != nil {
		return LocalCapture{}, err
	}
	if len(data) == 0 || len(data) > MaxLocalCaptureInput {
		return LocalCapture{}, fmt.Errorf("test input must be between 1 and %d bytes", MaxLocalCaptureInput)
	}
	var pdf []byte
	var err error
	switch format {
	case "jpeg":
		if paperMM != 0 && paperMM != 58 && paperMM != 80 {
			return LocalCapture{}, fmt.Errorf("receipt width must be 58 or 80 mm")
		}
		if paperMM == 0 {
			pdf, err = JPEGToPDF(data)
		} else {
			pdf, err = JPEGToPDFReceipt(data, paperMM, 0, 0)
		}
		if err != nil {
			return LocalCapture{}, fmt.Errorf("convert JPEG to PDF: %w", err)
		}
	case "pdf":
		if paperMM != 0 {
			return LocalCapture{}, fmt.Errorf("PDF uploads retain their embedded page sizes")
		}
		pdf = data
	default:
		return LocalCapture{}, fmt.Errorf("unsupported test document format")
	}
	if err := ValidatePDF(pdf); err != nil {
		return LocalCapture{}, err
	}
	preview, pages, err := renderLocalPDFPreview(ctx, pdf)
	if err != nil {
		return LocalCapture{}, fmt.Errorf("PDFium verification: %w", err)
	}
	return LocalCapture{PDF: pdf, PreviewPNG: preview, Pages: pages}, nil
}
