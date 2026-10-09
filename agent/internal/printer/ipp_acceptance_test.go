package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// These fixtures retain group and value tags. The existing flattened attribute
// map cannot distinguish a Job attribute from a Printer/Unsupported attribute,
// or an integer job-id from an ASCII string that happens to contain digits.
type ippEvidenceTestAttribute struct {
	group byte
	tag   byte
	name  string
	value []byte
}

type ippEvidenceTestResponse struct {
	version   [2]byte
	status    uint16
	requestID uint32
	attrs     []ippEvidenceTestAttribute
}

func ippEvidenceTestInt(value int32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, uint32(value))
	return b
}

func ippEvidenceTestJob(state int32) ippEvidenceTestResponse {
	reason := "none"
	if state == 9 {
		reason = "job-completed-successfully"
	}
	return ippEvidenceTestResponse{
		version: [2]byte{2, 0}, requestID: 1,
		attrs: []ippEvidenceTestAttribute{
			{1, 0x47, "attributes-charset", []byte("utf-8")},
			{1, 0x48, "attributes-natural-language", []byte("en")},
			{2, 0x21, "job-id", ippEvidenceTestInt(42)},
			{2, 0x45, "job-uri", []byte("ipp://printer.example/jobs/42")},
			{2, 0x23, "job-state", ippEvidenceTestInt(state)},
			{2, 0x44, "job-state-reasons", []byte(reason)},
		},
	}
}

func (r ippEvidenceTestResponse) bytes() []byte {
	var b bytes.Buffer
	b.Write(r.version[:])
	_ = binary.Write(&b, binary.BigEndian, r.status)
	_ = binary.Write(&b, binary.BigEndian, r.requestID)
	var group byte
	for _, attr := range r.attrs {
		if attr.group != group {
			b.WriteByte(attr.group)
			group = attr.group
		}
		b.WriteByte(attr.tag)
		_ = binary.Write(&b, binary.BigEndian, uint16(len(attr.name)))
		b.WriteString(attr.name)
		_ = binary.Write(&b, binary.BigEndian, uint16(len(attr.value)))
		b.Write(attr.value)
	}
	b.WriteByte(3)
	return b.Bytes()
}

func (r *ippEvidenceTestResponse) attr(name string) *ippEvidenceTestAttribute {
	for i := range r.attrs {
		if r.attrs[i].name == name {
			return &r.attrs[i]
		}
	}
	panic("missing fixture attribute: " + name)
}

func (r *ippEvidenceTestResponse) omit(name string) {
	for i := range r.attrs {
		if r.attrs[i].name == name {
			r.attrs = append(r.attrs[:i], r.attrs[i+1:]...)
			return
		}
	}
	panic("missing fixture attribute: " + name)
}

// Reused by successful existing native-PDF, Windows PWG and Windows JPEG
// fixtures. Acceptance means a protocol Job was created, not verified paper.
func ippAcceptedJobResponse(status uint16, state int32) []byte {
	r := ippEvidenceTestJob(state)
	r.status = status
	return r.bytes()
}

func ippEvidenceTestRefusal(status uint16) ippEvidenceTestResponse {
	r := ippEvidenceTestJob(3)
	r.status = status
	r.attrs = r.attrs[:2]
	return r
}

func ippRejectedJobResponse(status uint16) []byte {
	return ippEvidenceTestRefusal(status).bytes()
}

func ippEvidenceTestProbe() []byte {
	r := ippEvidenceTestResponse{version: [2]byte{2, 0}, requestID: 1}
	r.attrs = []ippEvidenceTestAttribute{
		{1, 0x47, "attributes-charset", []byte("utf-8")},
		{1, 0x48, "attributes-natural-language", []byte("en")},
		{4, 0x49, "document-format-supported", []byte(ippFormatPDF)},
		{4, 0x49, "", []byte("image/pwg-raster")},
		{4, 0x49, "", []byte("image/jpeg")},
		{4, 0x23, "printer-state", ippEvidenceTestInt(3)},
		{4, 0x22, "printer-is-accepting-jobs", []byte{1}},
	}
	return r.bytes()
}

// Exercises the actual IPPPrinter, format preflight and HTTP transport. The
// loopback peer supplies protocol fixtures; it is not a physical IPP printer.
func submitIPPTestResponse(t *testing.T, response []byte) error {
	t.Helper()
	var probes, submissions atomic.Int32
	pdf := validPDF()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil || len(body) < 8 {
			t.Errorf("read actual IPP request: length=%d err=%v", len(body), err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/ipp")
		switch binary.BigEndian.Uint16(body[2:4]) {
		case 0x000b:
			probes.Add(1)
			_, _ = w.Write(ippEvidenceTestProbe())
		case 0x0002:
			submissions.Add(1)
			if !bytes.HasSuffix(body, pdf) || !bytes.Contains(body, []byte(ippFormatPDF)) {
				t.Error("actual Print-Job lost native PDF bytes/format")
			}
			if binary.BigEndian.Uint32(body[4:8]) != 1 {
				t.Error("fixture does not echo actual request-id")
			}
			_, _ = w.Write(response)
		default:
			t.Errorf("unexpected IPP operation 0x%04x", binary.BigEndian.Uint16(body[2:4]))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "acceptance evidence")
	if err != nil {
		t.Fatal(err)
	}
	err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: pdf})
	if probes.Load() != 1 || submissions.Load() != 1 {
		t.Errorf("must not resend or fall back after Print-Job: probes=%d submissions=%d", probes.Load(), submissions.Load())
	}
	return err
}

func testIPPPrintJobResponse(t *testing.T, response []byte, wantUnknown bool) {
	t.Helper()
	err := submitIPPTestResponse(t, response)
	if wantUnknown {
		if !OutcomeUnknown(err) {
			t.Errorf("submitted document with unusable evidence must be UNKNOWN, got %v", err)
		}
	} else if err != nil {
		t.Errorf("valid returned Job must be accepted: %v", err)
	}
}

func TestIPPClientRefusalRequiresCorrelatedOperationEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*ippEvidenceTestResponse)
	}{
		{"missing_charset", func(r *ippEvidenceTestResponse) { r.omit("attributes-charset") }},
		{"missing_language", func(r *ippEvidenceTestResponse) { r.omit("attributes-natural-language") }},
		{"charset_wrong_tag", func(r *ippEvidenceTestResponse) { r.attr("attributes-charset").tag = 0x44 }},
		{"charset_wrong_value", func(r *ippEvidenceTestResponse) { r.attr("attributes-charset").value = []byte("us-ascii") }},
		{"language_wrong_tag", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").tag = 0x44 }},
		{"language_empty", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = nil }},
		{"language_bad_syntax", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("en--us") }},
		{"language_uppercase", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("EN") }},
		{"duplicate_charset", func(r *ippEvidenceTestResponse) { r.attrs = append(r.attrs, *r.attr("attributes-charset")) }},
		{"duplicate_language", func(r *ippEvidenceTestResponse) { r.attrs = append(r.attrs, *r.attr("attributes-natural-language")) }},
		{"reordered_operation_attributes", func(r *ippEvidenceTestResponse) { r.attrs[0], r.attrs[1] = r.attrs[1], r.attrs[0] }},
		// NOT_A_DEFECT control: the existing framing parser already rejects
		// request-id != 1, matching the current Print-Job builder's ID.
		{"wrong_request_id_existing_fence", func(r *ippEvidenceTestResponse) { r.requestID = 2 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := ippEvidenceTestRefusal(0x040a)
			tc.change(&r)
			if err := submitIPPTestResponse(t, r.bytes()); !OutcomeUnknown(err) {
				t.Errorf("unusable refusal envelope after submission must remain UNKNOWN: %v", err)
			}
		})
	}
	for _, code := range []uint16{0x0404, 0x040a} {
		t.Run("valid_refusal_"+ippStatusText(code), func(t *testing.T) {
			r := ippEvidenceTestRefusal(code)
			r.attr("attributes-natural-language").value = []byte("fr")
			err := submitIPPTestResponse(t, r.bytes())
			if err == nil || OutcomeUnknown(err) {
				t.Fatalf("correlated typed refusal must remain a definite error: %v", err)
			}
			if code == 0x040a && (!strings.Contains(err.Error(), "0x040A") || !strings.Contains(err.Error(), ippFormatPDF)) {
				t.Errorf("valid format refusal lost actionable MIME/status guidance: %v", err)
			}
		})
	}
}

func TestIPPPrintJobRequiresTypedReturnedEvidence(t *testing.T) {
	cases := []struct {
		name   string
		change func(*ippEvidenceTestResponse)
	}{
		{"missing_charset", func(r *ippEvidenceTestResponse) { r.omit("attributes-charset") }},
		{"missing_language", func(r *ippEvidenceTestResponse) { r.omit("attributes-natural-language") }},
		{"charset_wrong_tag", func(r *ippEvidenceTestResponse) { r.attr("attributes-charset").tag = 0x44 }},
		{"charset_not_request_charset", func(r *ippEvidenceTestResponse) { r.attr("attributes-charset").value = []byte("us-ascii") }},
		{"language_wrong_tag", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").tag = 0x44 }},
		{"language_empty", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = nil }},
		{"language_bad_syntax", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("en--us") }},
		{"language_uppercase", func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("EN") }},
		{"language_overlong", func(r *ippEvidenceTestResponse) {
			r.attr("attributes-natural-language").value = []byte(strings.Repeat("a", 64))
		}},
		{"operation_attributes_reordered", func(r *ippEvidenceTestResponse) { r.attrs[0], r.attrs[1] = r.attrs[1], r.attrs[0] }},
		{"duplicate_charset", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs[:2], append([]ippEvidenceTestAttribute{r.attrs[0]}, r.attrs[2:]...)...)
		}},
		{"missing_job_id", func(r *ippEvidenceTestResponse) { r.omit("job-id") }},
		{"job_id_ascii_digits", func(r *ippEvidenceTestResponse) { a := r.attr("job-id"); a.tag, a.value = 0x42, []byte("42") }},
		{"job_id_enum_tag", func(r *ippEvidenceTestResponse) { r.attr("job-id").tag = 0x23 }},
		{"job_id_short", func(r *ippEvidenceTestResponse) { r.attr("job-id").value = []byte{42} }},
		{"job_id_zero", func(r *ippEvidenceTestResponse) { r.attr("job-id").value = ippEvidenceTestInt(0) }},
		{"job_id_negative", func(r *ippEvidenceTestResponse) { r.attr("job-id").value = ippEvidenceTestInt(-1) }},
		{"job_id_out_of_band", func(r *ippEvidenceTestResponse) { a := r.attr("job-id"); a.tag, a.value = 0x12, nil }},
		{"job_id_operation_group", func(r *ippEvidenceTestResponse) { r.attr("job-id").group = 1 }},
		{"job_evidence_printer_group", func(r *ippEvidenceTestResponse) {
			for i := 2; i < len(r.attrs); i++ {
				r.attrs[i].group = 4
			}
		}},
		{"job_evidence_unsupported_group", func(r *ippEvidenceTestResponse) {
			for i := 2; i < len(r.attrs); i++ {
				r.attrs[i].group = 5
			}
		}},
		{"missing_job_uri", func(r *ippEvidenceTestResponse) { r.omit("job-uri") }},
		{"job_uri_wrong_tag", func(r *ippEvidenceTestResponse) { r.attr("job-uri").tag = 0x42 }},
		{"job_uri_empty", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = nil }},
		{"job_uri_relative", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = []byte("/jobs/42") }},
		{"job_uri_bad_escape", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = []byte("ipp://printer.example/%zz") }},
		{"job_uri_opaque_bad_escape", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = []byte("urn:printjob:%zz") }},
		{"job_uri_short_escape", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = []byte("urn:printjob:%a") }},
		{"job_uri_missing_host", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = []byte("ipp:///jobs/42") }},
		{"job_uri_space", func(r *ippEvidenceTestResponse) { r.attr("job-uri").value = []byte("ipp://printer.example/jobs/4 2") }},
		{"job_uri_overlong", func(r *ippEvidenceTestResponse) {
			r.attr("job-uri").value = []byte("ipp://printer.example/" + strings.Repeat("a", 1024))
		}},
		{"missing_job_state", func(r *ippEvidenceTestResponse) { r.omit("job-state") }},
		{"job_state_integer_tag", func(r *ippEvidenceTestResponse) { r.attr("job-state").tag = 0x21 }},
		{"job_state_short", func(r *ippEvidenceTestResponse) { r.attr("job-state").value = []byte{3} }},
		{"job_state_reserved", func(r *ippEvidenceTestResponse) { r.attr("job-state").value = ippEvidenceTestInt(2) }},
		{"job_state_unknown", func(r *ippEvidenceTestResponse) { r.attr("job-state").value = ippEvidenceTestInt(10) }},
		{"job_canceled", func(r *ippEvidenceTestResponse) { r.attr("job-state").value = ippEvidenceTestInt(7) }},
		{"job_aborted", func(r *ippEvidenceTestResponse) { r.attr("job-state").value = ippEvidenceTestInt(8) }},
		{"missing_job_reasons", func(r *ippEvidenceTestResponse) { r.omit("job-state-reasons") }},
		{"job_reasons_string_tag", func(r *ippEvidenceTestResponse) { r.attr("job-state-reasons").tag = 0x42 }},
		{"job_reasons_empty", func(r *ippEvidenceTestResponse) { r.attr("job-state-reasons").value = nil }},
		{"job_reasons_not_keyword", func(r *ippEvidenceTestResponse) { r.attr("job-state-reasons").value = []byte("not a keyword") }},
		{"job_reasons_uppercase", func(r *ippEvidenceTestResponse) { r.attr("job-state-reasons").value = []byte("NONE") }},
		{"job_reasons_overlong", func(r *ippEvidenceTestResponse) { r.attr("job-state-reasons").value = []byte(strings.Repeat("a", 256)) }},
		{"job_reasons_contradict_none", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x44, "", []byte("printer-stopped")})
		}},
		{"job_reasons_continuation_wrong_tag", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x42, "", []byte("printer-stopped")})
		}},
		{"duplicate_job_id", func(r *ippEvidenceTestResponse) { r.attrs = append(r.attrs, *r.attr("job-id")) }},
		{"multivalued_job_id", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs[:3], append([]ippEvidenceTestAttribute{{2, 0x21, "", ippEvidenceTestInt(43)}}, r.attrs[3:]...)...)
		}},
		{"duplicate_job_state", func(r *ippEvidenceTestResponse) { r.attrs = append(r.attrs, *r.attr("job-state")) }},
		{"duplicate_job_uri", func(r *ippEvidenceTestResponse) { r.attrs = append(r.attrs, *r.attr("job-uri")) }},
		{"wrong_request_id", func(r *ippEvidenceTestResponse) { r.requestID = 2 }},
		{"zero_request_id", func(r *ippEvidenceTestResponse) { r.requestID = 0 }},
		{"negative_request_id", func(r *ippEvidenceTestResponse) { r.requestID = 0x80000000 }},
		{"unsupported_minor_version", func(r *ippEvidenceTestResponse) { r.version = [2]byte{2, 255} }},
		{"negative_name_length", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x30, strings.Repeat("a", 32768), []byte("x")})
		}},
		{"negative_value_length", func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x30, "x-vendor-data", bytes.Repeat([]byte{'x'}, 32768)})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := ippEvidenceTestJob(3)
			tc.change(&r)
			testIPPPrintJobResponse(t, r.bytes(), true)
		})
	}
}

func TestIPPPrintJobMalformedFramingIsUnknown(t *testing.T) {
	valid := ippAcceptedJobResponse(0, 3)
	cases := []struct {
		name     string
		response []byte
	}{
		{"header_only_success", []byte{2, 0, 0, 0, 0, 0, 0, 1, 3}},
		{"missing_end_tag", valid[:len(valid)-1]},
		{"trailing_bytes", append(append([]byte{}, valid...), 'x')},
		{"duplicate_end_tag", append(append([]byte{}, valid...), 3)},
		{"short_attribute", append(append([]byte{}, valid[:len(valid)-1]...), 0x44, 0, 5, 'x')},
		{"nameless_first_job_value", append(append([]byte{}, valid[:8]...), 2, 0x21, 0, 0, 0, 4, 0, 0, 0, 42, 3)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { testIPPPrintJobResponse(t, tc.response, true) })
	}
}

func TestIPPPrintJobDoesNotAcceptTruncatedResponseAtSizeLimit(t *testing.T) {
	// Create a complete, valid response ending exactly at the former 1-MiB
	// read boundary, then append a byte. A capped reader without an overflow
	// check used to hide that trailing data and accept the truncated response.
	r := ippEvidenceTestJob(3)
	remaining := (1 << 20) - len(r.bytes())
	for remaining > 0 {
		name := ""
		if remaining == (1<<20)-len(ippAcceptedJobResponse(0, 3)) {
			name = "x-padding"
		}
		overhead := 5 + len(name)
		n := min(32767, remaining-overhead)
		if n < 0 {
			t.Fatalf("bad overflow fixture remainder: %d", remaining)
		}
		// Leave room for another attribute's framing if this is not the last.
		if remaining-overhead-n > 0 && remaining-overhead-n < overhead {
			n -= overhead
		}
		r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x30, name, bytes.Repeat([]byte{'x'}, n)})
		remaining -= overhead + n
	}
	response := r.bytes()
	if len(response) != 1<<20 {
		t.Fatalf("fixture size=%d", len(response))
	}
	testIPPPrintJobResponse(t, append(response, 'x'), true)
}

func TestIPPPrintJobValidReturnedEvidenceIsAcceptedOnce(t *testing.T) {
	for _, state := range []int32{3, 4, 5, 6, 9} {
		t.Run("state_"+string(rune('0'+state)), func(t *testing.T) {
			testIPPPrintJobResponse(t, ippAcceptedJobResponse(0, state), false)
		})
	}
	for name, change := range map[string]func(*ippEvidenceTestResponse){
		"substituted_success":        func(r *ippEvidenceTestResponse) { r.status = 1 },
		"alternate_natural_language": func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("ar-eg") },
		"maximum_job_id":             func(r *ippEvidenceTestResponse) { r.attr("job-id").value = ippEvidenceTestInt(0x7fffffff) },
		"job_attributes_reordered":   func(r *ippEvidenceTestResponse) { r.attrs[2], r.attrs[5] = r.attrs[5], r.attrs[2] },
		"multiple_reason_keywords": func(r *ippEvidenceTestResponse) {
			r.attr("job-state-reasons").value = []byte("job-incoming")
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x44, "", []byte("vendor-holding_1.2")})
		},
		"unsupported_group_ignored": func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs[:2], append([]ippEvidenceTestAttribute{{5, 0x10, "copies", nil}}, r.attrs[2:]...)...)
		},
		"optional_job_attributes": func(r *ippEvidenceTestResponse) {
			r.attrs = append(r.attrs, ippEvidenceTestAttribute{2, 0x41, "job-state-message", []byte("queued")})
		},
		"ipp_1_1":                  func(r *ippEvidenceTestResponse) { r.version = [2]byte{1, 1} },
		"ipp_2_2":                  func(r *ippEvidenceTestResponse) { r.version = [2]byte{2, 2} },
		"compatible_future_minor":  func(r *ippEvidenceTestResponse) { r.version = [2]byte{2, 3} },
		"private_natural_language": func(r *ippEvidenceTestResponse) { r.attr("attributes-natural-language").value = []byte("x-print") },
		"opaque_job_uri": func(r *ippEvidenceTestResponse) {
			r.attr("job-uri").value = []byte("urn:uuid:d08305a7-2bce-4554-bfb3-ae06336597d5")
		},
		"escaped_job_uri": func(r *ippEvidenceTestResponse) {
			r.attr("job-uri").value = []byte("ipp://printer.example/jobs/42%2Fa")
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := ippEvidenceTestJob(3)
			change(&r)
			testIPPPrintJobResponse(t, r.bytes(), false)
		})
	}
}

func TestIPPPreparedDocumentFormatsShareAcceptanceBoundary(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	var pwg, jpg bytes.Buffer
	pwg.WriteString("RaS2")
	if err := encodePWGPage(&pwg, img, 150, 1, 72, 72, pwgGray8); err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(&jpg, img, nil); err != nil {
		t.Fatal(err)
	}
	for _, doc := range []struct {
		name, format string
		data         []byte
	}{
		{"pdf", ippFormatPDF, validPDF()},
		{"pwg", "image/pwg-raster", pwg.Bytes()},
		{"jpeg", "image/jpeg", jpg.Bytes()},
	} {
		for _, unknown := range []bool{false, true} {
			name := doc.name + "/valid"
			response := ippAcceptedJobResponse(0, 3)
			if unknown {
				name = doc.name + "/missing_evidence"
				response = []byte{2, 0, 0, 0, 0, 0, 0, 1, 3}
			}
			t.Run(name, func(t *testing.T) {
				var submissions atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					body, err := io.ReadAll(req.Body)
					if err != nil || len(body) < 8 {
						t.Errorf("read submission: %v", err)
						return
					}
					submissions.Add(1)
					if binary.BigEndian.Uint16(body[2:4]) != 2 || !bytes.HasSuffix(body, doc.data) || !bytes.Contains(body, []byte(doc.format)) {
						t.Error("actual printDocument changed prepared document format/bytes")
					}
					w.Header().Set("Content-Type", "application/ipp")
					_, _ = w.Write(response)
				}))
				defer server.Close()
				p, err := NewIPPPrinter(server.URL, "prepared format")
				if err != nil {
					t.Fatal(err)
				}
				// Portable preparation exercises real PWG/JPEG encoders and the
				// shared submission backend. Windows PDF conversion is separate.
				err = p.printDocument(context.Background(), doc.data, doc.format)
				if unknown && !OutcomeUnknown(err) {
					t.Errorf("unusable evidence must be UNKNOWN: %v", err)
				}
				if !unknown && err != nil {
					t.Errorf("valid evidence rejected: %v", err)
				}
				if submissions.Load() != 1 {
					t.Errorf("duplicate Print-Job: %d", submissions.Load())
				}
			})
		}
	}
}
