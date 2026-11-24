package printer

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestIPPProbeFailureNeverTransmitsDocument(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		body []byte
	}{
		{"authentication required", 401, ippEvidenceTestProbe()},
		{"forbidden", 403, ippEvidenceTestProbe()},
		{"wrong endpoint", 404, ippEvidenceTestProbe()},
		{"unavailable", 503, ippEvidenceTestProbe()},
		{"redirect", 307, ippEvidenceTestProbe()},
		{"unexpected HTTP success", 201, ippEvidenceTestProbe()},
		{"truncated attributes", 200, []byte{2, 0, 0}},
		{"missing formats", 200, ippAttrResponse()},
		{"empty formats", 200, ippAttrResponse(" ")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var probes, submissions atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				body, err := io.ReadAll(req.Body)
				if err != nil || len(body) < 8 {
					t.Errorf("invalid actual IPP request: length=%d error=%v", len(body), err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/ipp")
				if binary.BigEndian.Uint16(body[2:4]) == 0x000b {
					probes.Add(1)
					w.WriteHeader(tc.code)
					_, _ = w.Write(tc.body)
					return
				}
				submissions.Add(1)
				_, _ = w.Write(ippAcceptedJobResponse(0, 3))
			}))
			defer server.Close()
			p, err := NewIPPPrinter(server.URL, "capability refusal")
			if err != nil {
				t.Fatal(err)
			}
			err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
			if err == nil || OutcomeUnknown(err) || !strings.Contains(err.Error(), "document-format-supported") {
				t.Fatalf("expected safe pre-submission capability error, got %v", err)
			}
			if probes.Load() != 1 || submissions.Load() != 0 {
				t.Fatalf("failed capability verification transmitted a document: probes=%d submissions=%d", probes.Load(), submissions.Load())
			}
		})
	}
}

func TestIPPPrintJobRequiresHTTP200EvidenceWithoutRetry(t *testing.T) {
	for _, tc := range []struct {
		code        int
		contentType string
		accepted    bool
	}{
		{200, "application/ipp", true},
		{201, "application/ipp", false},
		{202, "application/ipp", false},
		{204, "application/ipp", false},
		{206, "application/ipp", false},
		{299, "application/ipp", false},
		{307, "application/ipp", false},
		{400, "application/ipp", false},
		{401, "application/ipp", false},
		{403, "application/ipp", false},
		{404, "application/ipp", false},
		{408, "application/ipp", false},
		{429, "application/ipp", false},
		{500, "application/ipp", false},
		{503, "application/ipp", false},
		{200, "application/ipp; charset=utf-8", true},
		{200, "APPLICATION/IPP", true},
		{200, "", false},
		{200, "text/plain", false},
		{200, "application/json", false},
		{200, "application/ipp; broken", false},
		{200, "application/ipp, text/plain", false},
	} {
		t.Run(fmt.Sprintf("HTTP%d/%s", tc.code, tc.contentType), func(t *testing.T) {
			var probes, submissions atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				body, err := io.ReadAll(req.Body)
				if err != nil || len(body) < 8 {
					t.Errorf("invalid actual IPP request: length=%d error=%v", len(body), err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/ipp")
				if binary.BigEndian.Uint16(body[2:4]) == 0x000b {
					probes.Add(1)
					_, _ = w.Write(ippEvidenceTestProbe())
					return
				}
				submissions.Add(1)
				if tc.contentType == "" {
					w.Header().Del("Content-Type")
				} else {
					w.Header().Set("Content-Type", tc.contentType)
				}
				w.WriteHeader(tc.code)
				_, _ = w.Write(ippAcceptedJobResponse(0, 3))
			}))
			defer server.Close()
			p, err := NewIPPPrinter(server.URL, "transport envelope")
			if err != nil {
				t.Fatal(err)
			}
			err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
			if tc.accepted {
				if err != nil {
					t.Fatalf("valid HTTP200 and accepted Job rejected: %v", err)
				}
			} else {
				if !OutcomeUnknown(err) {
					t.Fatalf("invalid transport evidence lost unknown outcome: %v", err)
				}
				if tc.code != http.StatusOK && !strings.Contains(err.Error(), fmt.Sprintf("HTTP %d", tc.code)) {
					t.Fatalf("non200 transport result lost HTTP diagnosis: %v", err)
				}
				if tc.code == http.StatusOK && !strings.Contains(err.Error(), "Content-Type") {
					t.Fatalf("invalid response media type lost diagnosis: %v", err)
				}
			}
			if probes.Load() != 1 || submissions.Load() != 1 {
				t.Fatalf("unexpected retry after submission: probes=%d submissions=%d", probes.Load(), submissions.Load())
			}
		})
	}
}
