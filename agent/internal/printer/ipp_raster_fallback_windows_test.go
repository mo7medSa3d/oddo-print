//go:build windows

package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Real PDFium conversion and a real HTTP exchange verify that only memory
// preparation can fall back. A submitted document is never replayed.
func TestIPPWindowsUnsupportedPWGVariantUsesAdvertisedJPEGOnce(t *testing.T) {
	for _, redirect := range []bool{false, true} {
		name := "accepted"
		if redirect {
			name = "redirect remains unknown without replay"
		}
		t.Run(name, func(t *testing.T) {
			var probes, prints atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body := readAll(r.Body)
				if len(body) < 8 {
					t.Error("short IPP request")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if binary.BigEndian.Uint16(body[2:4]) == 0x000b {
					probes.Add(1)
					base := ippAttrResponse("image/pwg-raster", "image/jpeg")
					var attrs bytes.Buffer
					attrs.Write(base[:len(base)-1])
					// The current PWG encoder cannot produce one-bit black.
					// JPEG is explicitly advertised as a separate viable format.
					writeIPPAttribute(&attrs, 0x44, "pwg-raster-document-type-supported", "black_1")
					attrs.WriteByte(0x03)
					w.Header().Set("Content-Type", "application/ipp")
					_, _ = w.Write(attrs.Bytes())
					return
				}
				prints.Add(1)
				if binary.BigEndian.Uint16(body[2:4]) != 0x0002 {
					t.Error("unexpected IPP operation")
				}
				if !bytes.Contains(body, []byte("image/jpeg")) {
					t.Error("submission did not declare JPEG")
				}
				start := bytes.Index(body, []byte{0xff, 0xd8, 0xff})
				if start < 0 {
					t.Error("submission has no JPEG image")
				} else if size, err := jpeg.DecodeConfig(bytes.NewReader(body[start:])); err != nil || size.Width <= 0 || size.Height <= 0 {
					t.Errorf("invalid converted JPEG: %+v %v", size, err)
				}
				if redirect {
					http.Redirect(w, r, "/must-not-replay", http.StatusTemporaryRedirect)
					return
				}
				w.Header().Set("Content-Type", "application/ipp")
				_, _ = w.Write(ippAcceptedJobResponse(0, 3))
			}))
			defer server.Close()
			p, err := NewIPPPrinter(server.URL, "PWG variant and JPEG")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
			defer cancel()
			err = p.PrintDocument(ctx, Document{Kind: KindPDF, Data: validPDF()})
			if redirect {
				if err == nil || !OutcomeUnknown(err) {
					t.Fatalf("post-submission redirect must remain unknown: %v", err)
				}
			} else if err != nil {
				t.Fatalf("advertised JPEG fallback failed: %v", err)
			}
			if probes.Load() != 1 || prints.Load() != 1 {
				t.Fatalf("expected one probe and one Print-Job, got %d/%d", probes.Load(), prints.Load())
			}
		})
	}
}
