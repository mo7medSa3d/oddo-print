//go:build windows

package printer

import (
	"bytes"
	"context"
	"image/png"
	"testing"
	"time"
)

// Runs on the native Windows Actions runner and exercises the REAL embedded
// PDFium WASM path without selecting a queue or calling the Windows spooler.
func TestLocalCapturePDFiumOnWindows(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	input := localTestJPEG(t)
	for _, paper := range []int{58, 80, 0} {
		rendered, err := CaptureTestDocument(ctx, input, "jpeg", paper)
		if err != nil {
			t.Fatalf("capture paper=%dmm: %v", paper, err)
		}
		if rendered.Pages != 1 {
			t.Fatalf("paper=%d: pages=%d", paper, rendered.Pages)
		}
		if !bytes.HasPrefix(rendered.PDF, []byte("%PDF-")) {
			t.Fatalf("paper=%d PDF signature missing", paper)
		}
		config, err := png.DecodeConfig(bytes.NewReader(rendered.PreviewPNG))
		if err != nil || config.Width <= 0 || config.Height <= 0 {
			t.Fatalf("paper=%d PNG preview invalid: %v", paper, err)
		}
	}
}
