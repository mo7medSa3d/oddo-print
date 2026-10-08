//go:build windows

package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A real embedded PDFium worker renders a real single-page PDF and emits
// decodable JFIF before contacting an IPP endpoint. This test also exercises
// the headless-safe WASM configuration used by the Agent Windows Service.
func TestIPPWindowsOnePagePDFToJPEG(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	result, err := renderIPPPDFToJPEG(ctx, validPDF())
	if err != nil {
		t.Fatalf("PDFium-to-JPEG fallback failed: %v", err)
	}
	if !bytes.HasPrefix(result, []byte{0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0, 1, 2}) {
		t.Fatal("IPP JPEG missing JFIF 1.02 APP0 header")
	}
	if !bytes.HasPrefix(result, []byte{0xff, 0xd8, 0xff}) {
		t.Fatalf("fallback output is not a JPEG")
	}
	size, err := jpeg.DecodeConfig(bytes.NewReader(result))
	if err != nil || size.Width <= 0 || size.Height <= 0 {
		t.Fatalf("invalid rendered JPEG (%v) %+v", err, size)
	}
}

func TestIPPWindowsJPEGOnlyPrinterReceivesConvertedDocument(t *testing.T) {
	var probes, prints int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		if len(body) < 8 {
			t.Error("empty IPP request")
			return
		}
		switch binary.BigEndian.Uint16(body[2:4]) {
		case 0x000B:
			probes++
			_, _ = w.Write(ippAttrResponse("image/jpeg", "image/pwg-raster"))
		case 0x0002:
			prints++
			if !bytes.Contains(body, []byte("image/jpeg")) {
				t.Error("fallback did not set document-format=image/jpeg")
			}
			idx := bytes.Index(body, []byte{0xff, 0xd8, 0xff})
			if idx < 0 {
				t.Error("missing JPEG in Print-Job")
			} else if _, err := jpeg.DecodeConfig(bytes.NewReader(body[idx:])); err != nil {
				t.Errorf("Print-Job contains corrupt JPEG: %v", err)
			}
			_, _ = w.Write([]byte{2, 0, 0, 0, 0, 0, 0, 1, 3})
		default:
			t.Errorf("unexpected IPP operation")
		}
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "JPEG-only")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	if err := p.PrintDocument(ctx, Document{Kind: KindPDF, Data: validPDF()}); err != nil {
		t.Fatalf("JPEG fallback submission failed: %v", err)
	}
	if probes != 1 || prints != 1 {
		t.Fatalf("expected one format query and one Print-Job; got %d and %d", probes, prints)
	}
}
