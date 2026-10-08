//go:build windows

package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Uses real embedded PDFium and a strict mock IPP printer. No physical
// driver or OS print queue is required to prove PWG document encoding.
func TestIPPWindowsPWGOnlyPrinterGetsRealRaster(t *testing.T) {
	pdf := validPDF()
	var probes, submissions int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body := readAll(req.Body)
		w.Header().Set("Content-Type", "application/ipp")
		if len(body) < 8 {
			t.Error("truncated IPP")
			return
		}
		switch binary.BigEndian.Uint16(body[2:4]) {
		case 0x000B:
			probes++
			var response bytes.Buffer
			response.Write([]byte{2, 0, 0, 0, 0, 0, 0, 1, 4})
			writeIPPAttribute(&response, 0x49, "document-format-supported", "image/pwg-raster")
			writeIPPAttribute(&response, 0x44, "pwg-raster-document-type-supported", "sgray_8")
			// IPP resolution type 0x32 = X(4) Y(4) units(1).
			response.WriteByte(0x32)
			binary.Write(&response, binary.BigEndian, uint16(len("pwg-raster-document-resolution-supported")))
			response.WriteString("pwg-raster-document-resolution-supported")
			binary.Write(&response, binary.BigEndian, uint16(9))
			binary.Write(&response, binary.BigEndian, uint32(150))
			binary.Write(&response, binary.BigEndian, uint32(150))
			response.WriteByte(3)
			response.WriteByte(3)
			_, _ = w.Write(response.Bytes())
		case 0x0002:
			submissions++
			if !bytes.Contains(body, []byte("image/pwg-raster")) {
				t.Error("wrong IPP MIME")
			}
			at := bytes.Index(body, []byte("RaS2"))
			if at == -1 || len(body) < at+4+pwgPageHeaderBytes {
				t.Error("missing or truncated PWG Raster document")
			} else if !bytes.Equal(body[at+4:at+13], []byte("PwgRaster")) {
				t.Error("invalid PWG page header")
			} else if got := binary.BigEndian.Uint32(body[at+4+276 : at+4+280]); got != 150 {
				t.Errorf("document ignores printer's advertised DPI: %d", got)
			}
			_, _ = w.Write([]byte{2, 0, 0, 0, 0, 0, 0, 1, 3})
		default:
			t.Errorf("unexpected IPP operation")
		}
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "PWG-only")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := p.PrintDocument(ctx, Document{Kind: KindPDF, Data: pdf}); err != nil {
		t.Fatalf("PWG conversion/submission: %v", err)
	}
	if probes != 1 || submissions != 1 {
		t.Fatalf("want exactly one preflight and one physical submission; probes=%d submissions=%d", probes, submissions)
	}
}
