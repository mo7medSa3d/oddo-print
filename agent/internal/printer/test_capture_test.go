package printer

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"
)

func localTestJPEG(t *testing.T) []byte {
	t.Helper()
	pic := image.NewRGBA(image.Rect(0, 0, 384, 220))
	for y := 0; y < 220; y++ {
		for x := 0; x < 384; x++ {
			pic.Set(x, y, color.White)
		}
	}
	var data bytes.Buffer
	if err := jpeg.Encode(&data, pic, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestLocalCaptureInputFence(t *testing.T) {
	validJPEG := localTestJPEG(t)
	for _, tc := range []struct {
		name   string
		format string
		mm     int
		data   []byte
		want   string
	}{
		{"missing", "jpeg", 80, nil, "test input"},
		{"oversized", "pdf", 0, make([]byte, MaxLocalCaptureInput+1), "test input"},
		{"unknown format", "virtual", 80, validJPEG, "unsupported"},
		{"bad width", "jpeg", 60, validJPEG, "receipt width"},
		{"pdf override", "pdf", 80, []byte("%PDF-1.4\n%%EOF"), "retain"},
		{"invalid jpeg", "jpeg", 58, []byte("not jpeg"), "convert JPEG"},
		{"invalid pdf", "pdf", 0, []byte("not a pdf"), "missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := CaptureTestDocument(context.Background(), tc.data, tc.format, tc.mm)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v", tc.want, err)
			}
		})
	}
}

func TestLocalCaptureCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := CaptureTestDocument(ctx, localTestJPEG(t), "jpeg", 58)
	if err != context.Canceled {
		t.Fatalf("expected context cancellation: %v", err)
	}
}

func TestLocalReceiptGeometryUsesProductionConverter(t *testing.T) {
	jpegBytes := localTestJPEG(t)
	for _, mm := range []int{58, 80} {
		pdf, err := JPEGToPDFReceipt(jpegBytes, mm, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := ValidatePDF(pdf); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(pdf, []byte("/MediaBox")) {
			t.Fatalf("%dmm receipt PDF missing paper geometry", mm)
		}
	}
}
