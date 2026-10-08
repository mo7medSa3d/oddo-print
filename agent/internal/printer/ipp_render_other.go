//go:build !windows

package printer

import (
	"context"
	"fmt"
)

// Production PDFium rasterization is built into the Windows Agent only.
// Do not pretend the original PDF bytes are JPEG on another OS.
func renderIPPPDFToJPEG(ctx context.Context, data []byte) ([]byte, error) {
	_ = ctx
	_ = data
	return nil, fmt.Errorf("PDF-to-JPEG IPP rendering requires the Windows Agent PDFium runtime")
}
