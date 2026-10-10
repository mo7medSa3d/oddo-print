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
	var prefix bytes.Buffer
	prefix.Write([]byte{0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x04})
	const maxBytes = 64 * 1024
	const attributeName = "padding"
	const attributeEnvelope = 1 + 2 + len(attributeName) + 2
	writeIPPAttribute(&prefix, 0x42, attributeName, strings.Repeat("x", maxBytes-9-attributeEnvelope-1))
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
