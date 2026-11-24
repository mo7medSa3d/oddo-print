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

func ippPrinterAttributesFixture() ippEvidenceTestResponse {
	return ippEvidenceTestResponse{
		version: [2]byte{2, 0}, requestID: 1,
		attrs: []ippEvidenceTestAttribute{
			{1, 0x47, "attributes-charset", []byte("utf-8")},
			{1, 0x48, "attributes-natural-language", []byte("en")},
			{4, 0x23, "printer-state", ippEvidenceTestInt(3)},
			{4, 0x22, "printer-is-accepting-jobs", []byte{1}},
			{4, 0x44, "printer-state-reasons", []byte("none")},
			{4, 0x49, "document-format-supported", []byte(ippFormatPDF)},
		},
	}
}

func TestIPPPrinterAttributesRejectMalformedEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*ippEvidenceTestResponse)
	}{
		{"wrong_request_id", func(r *ippEvidenceTestResponse) { r.requestID = 2 }},
		{"negative_minor_version", func(r *ippEvidenceTestResponse) { r.version[1] = 255 }},
		{"wrong_major_version", func(r *ippEvidenceTestResponse) { r.version[0] = 3 }},
		{"error_status", func(r *ippEvidenceTestResponse) { r.status = 0x0402 }},
		{"missing_charset", func(r *ippEvidenceTestResponse) { r.omit("attributes-charset") }},
		{"missing_language", func(r *ippEvidenceTestResponse) { r.omit("attributes-natural-language") }},
		{"charset_wrong_type", func(r *ippEvidenceTestResponse) { r.attr("attributes-charset").tag = 0x44 }},
		{"charset_wrong_value", func(r *ippEvidenceTestResponse) { r.attr("attributes-charset").value = []byte("us-ascii") }},
		{"language_wrong_type", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").tag = 0x44 }},
		{"language_bad_syntax", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("en--us") }},
		{"operation_attributes_reordered", func(r *ippEvidenceTestResponse) { r.attrs[0], r.attrs[1] = r.attrs[1], r.attrs[0] }},
		{"state_ascii_name", func(r *ippEvidenceTestResponse) { a := r.attr("printer-state"); a.tag, a.value = 0x42, []byte("3") }},
		{"state_integer_type", func(r *ippEvidenceTestResponse) { r.attr("printer-state").tag = 0x21 }},
		{"state_short", func(r *ippEvidenceTestResponse) { r.attr("printer-state").value = []byte{3} }},
		{"state_outside_defined_values", func(r *ippEvidenceTestResponse) { r.attr("printer-state").value = ippEvidenceTestInt(6) }},
		{"boolean_two", func(r *ippEvidenceTestResponse) { r.attr("printer-is-accepting-jobs").value = []byte{2} }},
		{"boolean_ascii", func(r *ippEvidenceTestResponse) {
			a := r.attr("printer-is-accepting-jobs")
			a.tag, a.value = 0x42, []byte("true")
		}},
		{"format_keyword_type", func(r *ippEvidenceTestResponse) { r.attr("document-format-supported").tag = 0x44 }},
		{"format_csv_injection", func(r *ippEvidenceTestResponse) {
			r.attr("document-format-supported").value = []byte("application/x-vendor,application/pdf")
		}},
		{"format_malformed_mime", func(r *ippEvidenceTestResponse) {
			r.attr("document-format-supported").value = []byte("not-a-media-type")
		}},
		{"format_empty", func(r *ippEvidenceTestResponse) { r.attr("document-format-supported").value = nil }},
		{"duplicate_named_format", func(r *ippEvidenceTestResponse) { r.attrs = append(r.attrs, *r.attr("document-format-supported")) }},
		{"format_continuation_wrong_type", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{4, 0x44, "", []byte("image/jpeg")})
		}},
		{"state_additional_value", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs[:3], append([]ippEvidenceTestAttribute{{4, 0x23, "", ippEvidenceTestInt(4)}}, r.attrs[3:]...)...)
		}},
		{"unavailable_format_with_value", func(r *ippEvidenceTestResponse) { r.attr("document-format-supported").tag = 0x12 }},
		{"repeated_printer_group", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{5, 0x10, "copies", nil}, ippEvidenceTestAttribute{4, 0x42, "x-vendor", []byte("x")})
		}},
		{"negative_value_length", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{4, 0x30, "x-padding", bytes.Repeat([]byte{'x'}, 32768)})
		}},
		{"none_with_other_reason", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs[:5], append([]ippEvidenceTestAttribute{{4, 0x44, "", []byte("media-empty")}}, r.attrs[5:]...)...)
		}},
		{"unclosed_collection", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{4, 0x34, "x-vendor", nil})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := ippPrinterAttributesFixture()
			tc.change(&r)
			if attrs, err := parseIPPPrinterAttributes(r.bytes(), 1); err == nil {
				t.Fatalf("malformed printer evidence was accepted: %v", attrs)
			}
		})
	}
	valid := ippPrinterAttributesFixture().bytes()
	for _, response := range [][]byte{valid[:8], valid[:len(valid)-1], append(append([]byte{}, valid...), 'x'), append(append([]byte{}, valid[:len(valid)-1]...), 4, 3)} {
		if _, err := parseIPPPrinterAttributes(response, 1); err == nil {
			t.Fatal("incomplete or trailing capability response was accepted")
		}
	}
}

func TestIPPPrinterAttributesOnlyUsePrinterGroupEvidence(t *testing.T) {
	for _, group := range []byte{1, 5} {
		t.Run(string(rune('0'+group)), func(t *testing.T) {
			r := ippPrinterAttributesFixture()
			r.attrs = append(r.attrs[:2], ippEvidenceTestAttribute{group, 0x49, "document-format-supported", []byte(ippFormatPDF)})
			attrs, err := parseIPPPrinterAttributes(r.bytes(), 1)
			if err != nil || attrs["document-format-supported"] != "" {
				t.Fatalf("non-Printer format supplied capability evidence: %v %v", attrs, err)
			}
		})
	}
	for _, unavailable := range []byte{0x10, 0x12, 0x13} {
		r := ippPrinterAttributesFixture()
		a := r.attr("document-format-supported")
		a.tag, a.value = unavailable, nil
		attrs, err := parseIPPPrinterAttributes(r.bytes(), 1)
		if err != nil || attrs["document-format-supported"] != "" || attrs["printer-state"] != "3" {
			t.Fatalf("filtered capability was rejected or promoted: %v %v", attrs, err)
		}
	}
}

func TestIPPPrinterAttributesAllowValidAdditionalValuesAndUnknownCollections(t *testing.T) {
	r := ippPrinterAttributesFixture()
	r.attrs = append(r.attrs,
		ippEvidenceTestAttribute{4, 0x49, "", []byte("image/jpeg")},
		ippEvidenceTestAttribute{4, 0x34, "x-vendor-collection", nil},
		ippEvidenceTestAttribute{4, 0x4a, "", []byte("printer-state")},
		ippEvidenceTestAttribute{4, 0x23, "", ippEvidenceTestInt(5)},
		ippEvidenceTestAttribute{4, 0x4a, "", []byte("nested")},
		ippEvidenceTestAttribute{4, 0x34, "", nil},
		ippEvidenceTestAttribute{4, 0x4a, "", []byte("document-format-supported")},
		ippEvidenceTestAttribute{4, 0x49, "", []byte("application/x-unrequested")},
		ippEvidenceTestAttribute{4, 0x37, "", nil},
		ippEvidenceTestAttribute{4, 0x37, "", nil},
		ippEvidenceTestAttribute{4, 0x7f, "x-vendor-extended-type", []byte{0x40, 0, 0, 1, 'x'}},
	)
	attrs, err := parseIPPPrinterAttributes(r.bytes(), 1)
	if err != nil || attrs["printer-state"] != "3" || attrs["document-format-supported"] != "application/pdf,image/jpeg" {
		t.Fatalf("valid values lost or nested values escaped their collection: %v %v", attrs, err)
	}
	for _, minor := range []byte{0, 1, 2, 3} {
		r.version = [2]byte{2, minor}
		if _, err := parseIPPPrinterAttributes(r.bytes(), 1); err != nil {
			t.Fatalf("compatible IPP version rejected: %v", err)
		}
	}
}

func TestIPPPrinterAttributesQuotedMIMEParametersCannotCreateAnotherFormat(t *testing.T) {
	for _, separatePDF := range []bool{false, true} {
		r := ippPrinterAttributesFixture()
		r.attr("document-format-supported").value = []byte(`application/x-vendor; profile="x,application/pdf,y"`)
		if separatePDF {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{4, 0x49, "", []byte(ippFormatPDF)})
		}
		attrs, err := parseIPPPrinterAttributes(r.bytes(), 1)
		if err != nil {
			t.Fatalf("valid quoted MIME parameter rejected the whole response: %v", err)
		}
		formats := parseIPPSupportedFormats(attrs)
		if containsIPPFormat(formats, ippFormatPDF) != separatePDF || len(formats) > 1 {
			t.Fatalf("quoted parameter manufactured a format or hid independent PDF support: %v", formats)
		}
	}
}

func TestIPPPrinterAttributesPreserveUnsupportedResolutionEvidence(t *testing.T) {
	r := ippPrinterAttributesFixture()
	resolution := append(ippEvidenceTestInt(2400), ippEvidenceTestInt(2400)...)
	resolution = append(resolution, 3)
	r.attrs = append(r.attrs, ippEvidenceTestAttribute{4, 0x32, "pwg-raster-document-resolution-supported", resolution})
	attrs, err := parseIPPPrinterAttributes(r.bytes(), 1)
	if err != nil || attrs["pwg-raster-document-resolution-supported"] != "2400x2400dpi" {
		t.Fatalf("explicit resolution was dropped: %v %v", attrs, err)
	}
	if _, _, err := pwgOptionsFromIPPAttributes(attrs); err == nil {
		t.Fatal("unusable advertised resolution silently restored an unadvertised default")
	}
}

func TestIPPPrinterAttributesRequireHTTPAndIPPContentType(t *testing.T) {
	for _, tc := range []struct {
		name, contentType string
		status            int
		valid             bool
	}{
		{"standard", "application/ipp", 200, true},
		{"media_type_parameters", "Application/IPP; charset=utf-8", 200, true},
		{"missing_type", "", 200, false},
		{"wrong_type", "text/html", 200, false},
		{"malformed_type", "application/ipp; broken", 200, false},
		{"accepted_without_result", "application/ipp", 202, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				body := readAll(req.Body)
				if len(body) < 8 || binary.BigEndian.Uint16(body[2:4]) != 0x000b || req.Header.Get("Accept") != "application/ipp" {
					t.Error("capability query lost its IPP operation or media negotiation")
				}
				if tc.contentType != "" {
					w.Header().Set("Content-Type", tc.contentType)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write(ippPrinterAttributesFixture().bytes())
			}))
			defer server.Close()
			p, err := NewIPPPrinter(server.URL, "capability transport")
			if err != nil {
				t.Fatal(err)
			}
			attrs, err := p.getPrinterAttributes(context.Background())
			if (err == nil) != tc.valid || (tc.valid && attrs["printer-state"] != "3") {
				t.Fatalf("HTTP/MIME evidence decision mismatch: %v %v", attrs, err)
			}
		})
	}
}

func TestIPPInvalidStateEvidenceDoesNotPromoteDiscoveryOrHealth(t *testing.T) {
	r := ippPrinterAttributesFixture()
	a := r.attr("printer-state")
	a.tag, a.value = 0x42, []byte("3")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/ipp")
		_, _ = w.Write(r.bytes())
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "invalid state")
	if err != nil {
		t.Fatal(err)
	}
	if status := p.Status(); status != "unknown" {
		t.Fatalf("malformed state reported physical readiness: %s", status)
	}
	devices := []DeviceInfo{mdnsCandidateForVerification("10.0.0.27")}
	verifyMDNSIPPCandidatesWithProbe(context.Background(), devices, func(ctx context.Context, _ DeviceInfo) (map[string]string, error) {
		return p.getPrinterAttributes(ctx)
	})
	if isCapabilityVerified(devices[0].Capabilities, "ipp_verified") || !strings.EqualFold(devices[0].Status, "unknown") {
		t.Fatalf("malformed wire state promoted discovery: %+v", devices[0])
	}
}
