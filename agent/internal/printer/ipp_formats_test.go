package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func ippAttrResponse(formats ...string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00, 0, 0, 0, 0, 0, 1})
	buf.WriteByte(0x04)
	for i, format := range formats {
		name := ""
		if i == 0 {
			name = "document-format-supported"
		}
		writeIPPAttribute(&buf, 0x49, name, format)
	}
	buf.WriteByte(0x03)
	return buf.Bytes()
}

func TestIPPAdvertisedFormatsAndPreflightRequest(t *testing.T) {
	parsed := parseIPPAttributes(ippAttrResponse("IMAGE/PWG-RASTER", "image/jpeg", "application/pdf", "image/jpeg"))
	formats := parseIPPSupportedFormats(parsed)
	if len(formats) != 3 || formats[0] != "image/pwg-raster" || formats[1] != "image/jpeg" || formats[2] != "application/pdf" {
		t.Fatalf("invalid repeated MIME values: %#v", formats)
	}
	req := buildIPPGetPrinterAttributes("ipp://test.local/ipp/print")
	if bytes.Count(req, []byte("document-format-supported")) != 1 || !bytes.Contains(req, []byte("document-format-default")) {
		t.Fatal("Get-Printer-Attributes must request explicit supported document formats")
	}
}

func TestIPPNativePDFIsSubmittedExactlyOnceWhenSupported(t *testing.T) {
	var probes, submissions int
	pdf := validTestPDFBytes()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := readAll(r.Body)
		w.Header().Set("Content-Type", "application/ipp")
		if len(data) < 8 {
			t.Error("short IPP request")
			return
		}
		switch binary.BigEndian.Uint16(data[2:4]) {
		case 0x000B:
			probes++
			_, _ = w.Write(ippAttrResponse("image/pwg-raster", "application/pdf"))
		case 0x0002:
			submissions++
			if !bytes.Contains(data, []byte(ippFormatPDF)) || !bytes.HasSuffix(data, pdf) {
				t.Errorf("IPP client did not submit native PDF with correct format")
			}
			_, _ = w.Write(ippAcceptedJobResponse(0, 3))
		default:
			t.Errorf("unexpected IPP operation")
		}
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "PDF supported")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: pdf}); err != nil {
		t.Fatal(err)
	}
	if probes != 1 || submissions != 1 {
		t.Fatalf("unexpected duplicates: capability probes %d print submissions %d", probes, submissions)
	}
}

func TestIPPRasterOnlyDeviceRejectsPDFBeforeNetworkPrintJob(t *testing.T) {
	var probes, submissions int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		w.Header().Set("Content-Type", "application/ipp")
		if len(body) >= 4 && binary.BigEndian.Uint16(body[2:4]) == 0x000B {
			probes++
			_, _ = w.Write(ippAttrResponse("image/pwg-raster", "image/urf"))
			return
		}
		submissions++
		t.Error("IPP client sent PDF to a device which explicitly rejects application/pdf")
		_, _ = w.Write(ippRejectedJobResponse(0x040a))
	}))
	defer server.Close()
	p, _ := NewIPPPrinter(server.URL, "raster-only device")
	err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
	if err == nil || !strings.Contains(err.Error(), "image/pwg-raster") || !strings.Contains(strings.ToLower(err.Error()), "windows") {
		t.Fatalf("want actionable unsupported-PDF guidance, got %v", err)
	}
	if probes != 1 || submissions != 0 {
		t.Fatalf("unsupported PDF was sent or duplicated: probes=%d print=%d", probes, submissions)
	}
}

func TestIPPRejectingJobsDoesNotTransmitDocument(t *testing.T) {
	var printCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		if len(body) < 4 {
			t.Error("short IPP request")
			return
		}
		if binary.BigEndian.Uint16(body[2:4]) == 0x000B {
			var attrs bytes.Buffer
			attrs.Write([]byte{2, 0, 0, 0, 0, 0, 0, 1, 4})
			writeIPPAttribute(&attrs, 0x49, "document-format-supported", "application/pdf")
			writeIPPBoolAttr(&attrs, "printer-is-accepting-jobs", false)
			attrs.WriteByte(3)
			_, _ = w.Write(attrs.Bytes())
			return
		}
		printCount++
	}))
	defer server.Close()
	p, _ := NewIPPPrinter(server.URL, "stopped")
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()}); err == nil || !strings.Contains(err.Error(), "rejecting new jobs") {
		t.Fatalf("expected printer-paused explanation, got %v", err)
	}
	if printCount != 0 {
		t.Fatalf("sent %d print jobs to a printer refusing new work", printCount)
	}
}

func TestIPPRejectedDocumentFormatReturnsActionableErrorWithoutRetry(t *testing.T) {
	var count int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := readAll(r.Body)
		if len(data) >= 4 && binary.BigEndian.Uint16(data[2:4]) == 0x000B {
			// Legacy printer does not report format list.
			_, _ = w.Write(ippAttrResponse())
			return
		}
		count++
		_, _ = w.Write(ippRejectedJobResponse(0x040a))
	}))
	defer server.Close()
	p, _ := NewIPPPrinter(server.URL, "legacy")
	err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
	if err == nil || !strings.Contains(err.Error(), "0x040A") || !strings.Contains(err.Error(), "application/pdf") {
		t.Fatalf("expected explicit unsupported MIME error: %v", err)
	}
	if count != 1 {
		t.Fatalf("unsafe retry after explicit 0x040a: %d Print-Jobs", count)
	}
}

func TestIPPUnknownAdvertisedMimeMustNeverTriggerPDF(t *testing.T) {
	var count int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		if len(body) >= 4 && binary.BigEndian.Uint16(body[2:4]) == 0x000B {
			_, _ = w.Write(ippAttrResponse("application/x-unknown-printer-language"))
			return
		}
		count++
		t.Error("unsupported and explicitly reported format must not be sent as native PDF")
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "unsupported MIME")
	if err != nil {
		t.Fatal(err)
	}
	err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
	if err == nil || !strings.Contains(err.Error(), "document-format-supported") {
		t.Fatalf("expected explicit capabilities mismatch, got %v", err)
	}
	if count != 0 {
		t.Fatalf("unsupported print requests made: %d", count)
	}
}
