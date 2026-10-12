//go:build !windows

package printer

import "context"

func renderLocalPDFPreview(_ context.Context, _ []byte) ([]byte, int, error) {
	return nil, 0, CapabilityMismatchf("local PDFium capture requires the bundled Windows Agent")
}
