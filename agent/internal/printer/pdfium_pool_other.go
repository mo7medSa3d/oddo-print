//go:build !windows

package printer

import (
	"context"

	pdfium "github.com/klippa-app/go-pdfium"
)

// getPDFiumPool is declared here only so the platform-independent PDFium
// headless-execution tests compile off Windows. The real pool lives in
// pdf_windows.go because production PDF printing is tied to the Windows
// printer stack; off Windows there is no renderer to print through, so this
// implementation always fails with a capability error.
func getPDFiumPool() (pdfium.Pool, error) {
	_ = context.Background()
	return nil, CapabilityMismatchf("embedded PDFium rendering requires the Windows Agent printer backend")
}
