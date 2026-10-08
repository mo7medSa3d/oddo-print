//go:build !windows

package printer

import (
	"context"
	"fmt"
)

// The embedded PDFium rendering/IPP PWG pipeline is Windows-only.
func renderIPPPDFToPWG(ctx context.Context, pdfData []byte, attrs map[string]string) ([]byte, error) {
	_, _, _ = ctx, pdfData, attrs
	return nil, fmt.Errorf("PWG Raster conversion requires the Windows Agent embedded PDFium runtime")
}
