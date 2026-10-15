package printer

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The bounded IPP capability probe must reject oversized responses, including
// those whose first 64 KiB look like a complete, successful IPP message.
// Otherwise an untrusted printer can append data that is silently discarded
// and the Agent may incorrectly accept the apparent capability evidence.
func TestIPPAttributesRejectOversizedResponseWithCompletePrefix(t *testing.T) {
	base := ippAttrResponse(ippFormatPDF)
	var prefix bytes.Buffer
	prefix.Write(base[:len(base)-1])
	const maxBytes = 64 * 1024
	writeIPPAttribute(&prefix, 0x30, "padding", strings.Repeat("x", 32767))
	padding := maxBytes - prefix.Len() - 5 - 1
	if padding < 0 || padding > 32767 {
		t.Fatalf("invalid fixture padding size=%d", padding)
	}
	writeIPPAttribute(&prefix, 0x30, "", strings.Repeat("x", padding))
	prefix.WriteByte(0x03)
	if got := prefix.Len(); got != maxBytes {
		t.Fatalf("invalid fixture prefix size=%d, want %d", got, maxBytes)
	}
	for _, tc := range []struct {
		name      string
		body      []byte
		wantError bool
	}{
		{name: "exactly at limit", body: prefix.Bytes()},
		{name: "extra trailing byte", body: append(append([]byte(nil), prefix.Bytes()...), 0xff), wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/ipp")
				_, _ = w.Write(tc.body)
			}))
			defer srv.Close()
			printer := &IPPPrinter{URL: srv.URL, PrinterURI: srv.URL}
			_, err := printer.getPrinterAttributes(context.Background())
			if tc.wantError && err == nil {
				t.Fatal("oversized IPP response was accepted after silently truncating its tail")
			}
			if !tc.wantError && err != nil {
				t.Fatalf("valid at-limit IPP response rejected: %v", err)
			}
		})
	}
}
