package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/yasser-agent/agent/internal/config"
)

func TestIPPURLNormalization(t *testing.T) {
	cases := []struct {
		in, want  string
		shouldErr bool
	}{
		{"ipp://192.168.1.60/ipp/print", "http://192.168.1.60:631/ipp/print", false},
		{"ipps://192.168.1.60/ipp/print", "https://192.168.1.60:631/ipp/print", false},
		{"ipp://192.168.1.60:8631/ipp/print", "http://192.168.1.60:8631/ipp/print", false},
		{"ipps://192.168.1.60:9631/ipp/print", "https://192.168.1.60:9631/ipp/print", false},
		{"http://192.168.1.60/ipp/print", "http://192.168.1.60/ipp/print", false},
		{"https://192.168.1.60/ipp/print", "https://192.168.1.60/ipp/print", false},
		{"http://192.168.1.60:631/ipp/print", "http://192.168.1.60:631/ipp/print", false},
		{"https://192.168.1.60:631/ipp/print", "https://192.168.1.60:631/ipp/print", false},
		{"192.168.1.60:631", "http://192.168.1.60:631/ipp/print", false},
		{"192.168.1.60", "http://192.168.1.60:631/ipp/print", false},
		{"", "", true},
	}
	for _, tc := range cases {
		got, err := normalizeIPPURL(tc.in)
		if tc.shouldErr && err == nil {
			t.Errorf("expected error for %q", tc.in)
		}
		if !tc.shouldErr && err != nil {
			t.Errorf("unexpected error for %q: %v", tc.in, err)
		}
		if !tc.shouldErr && got.Redacted() != tc.want {
			t.Errorf("for %q want %q got %q", tc.in, tc.want, got.Redacted())
		}
	}
}

func TestIPPBuildPrintJob(t *testing.T) {
	url := "http://192.168.1.60/ipp/print"
	data := append([]byte("%PDF-1.4\n"), 0x00)
	req := buildIPPPrintJobWithFormat(url, data, ippFormatPDF)
	if len(req) < 10 {
		t.Fatalf("too short")
	}
	if req[0] != 0x02 || req[1] != 0x00 {
		t.Fatalf("version not 2.0")
	}
	if req[2] != 0x00 || req[3] != 0x02 {
		t.Fatalf("operation not Print-Job")
	}
	if !containsBytes(req, []byte("printer-uri")) {
		t.Fatalf("missing printer-uri")
	}
	if !containsBytes(req, []byte(url)) {
		t.Fatalf("missing url")
	}
	if !bytesHasSuffix(req, data) {
		t.Fatalf("document not at end")
	}
}

func TestIPPPrintDoesNotFollowRedirects(t *testing.T) {
	var redirectedHits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/capture" {
			redirectedHits++
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/capture", http.StatusTemporaryRedirect)
	}))
	defer server.Close()

	p, err := NewIPPPrinter(server.URL+"/ipp/print", "Redirect")
	if err != nil {
		t.Fatalf("NewIPPPrinter: %v", err)
	}
	err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
	if err == nil || !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("expected redirect response to be surfaced, got %v", err)
	}
	if redirectedHits != 0 {
		t.Fatalf("IPP client followed redirect and resubmitted the print payload")
	}
}
func TestIPPPrintWithMockServer(t *testing.T) {
	var received []byte
	var contentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		body := readAll(r.Body)
		received = body
		resp := []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x03}
		w.Header().Set("Content-Type", "application/ipp")
		w.WriteHeader(200)
		w.Write(resp)
	}))
	defer server.Close()

	p, err := NewIPPPrinter(server.URL, "Test IPP")
	if err != nil {
		t.Fatalf("NewIPPPrinter: %v", err)
	}
	data := validTestPDFBytes()
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: data}); err != nil {
		t.Fatalf("Print failed: %v", err)
	}
	if contentType != "application/ipp" {
		t.Fatalf("expected Content-Type application/ipp got %q", contentType)
	}
	if !bytesHasSuffix(received, data) {
		t.Fatalf("document not in IPP request")
	}
}

func TestIPPPrintAcceptsSuccessStatusClass(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/ipp")
		_, _ = w.Write([]byte{0x02, 0x00, 0x00, 0x01, 0, 0, 0, 1, 0x03})
	}))
	defer server.Close()
	p, _ := NewIPPPrinter(server.URL, "Test")
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()}); err != nil {
		t.Fatalf("0x0001 must be successful: %v", err)
	}
}

func TestIPPPrintClassifiesServerAndTruncatedResponses(t *testing.T) {
	for name, response := range map[string][]byte{
		"server":    {0x02, 0x00, 0x05, 0x03, 0, 0, 0, 1, 0x03},
		"truncated": {0x02, 0x00, 0x00},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(response) }))
			defer server.Close()
			p, _ := NewIPPPrinter(server.URL, "Test")
			err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
			if err == nil || !strings.Contains(err.Error(), ErrOutcomeUnknown.Error()) {
				t.Fatalf("expected unknown outcome, got %v", err)
			}
		})
	}
	if got := ippStatusText(0x0503); got != "server-error-version-not-supported" {
		t.Fatalf("unexpected 0x0503 description: %s", got)
	}
}

func TestIPPPrintErrorOnBadStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := []byte{0x02, 0x00, 0x04, 0x04, 0x00, 0x00, 0x00, 0x01, 0x03}
		w.Header().Set("Content-Type", "application/ipp")
		w.Write(resp)
	}))
	defer server.Close()
	p, _ := NewIPPPrinter(server.URL, "Test")
	err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
	if err == nil {
		t.Fatalf("expected error for IPP status 0x0404")
	}
	if !strings.Contains(err.Error(), "0x0404") {
		t.Fatalf("expected status in error, got %v", err)
	}
}

func TestFactoryIPP(t *testing.T) {
	cases := []struct {
		typ, endpoint, proto string
		shouldSucceed        bool
	}{
		{"ipp", "ipp://192.168.1.60/ipp/print", "ipp", true},
		{"ipps", "ipps://192.168.1.60/ipp/print", "ipps", true},
		{"network", "192.168.1.60:631", "ipp", true},
		{"network", "http://192.168.1.60:631/ipp/print", "ipp", true},
		{"ipp", "", "ipp", false},
	}
	for _, tc := range cases {
		cfg := config.PrinterConfig{ID: "p1", Name: "Test", Type: tc.typ, Endpoint: tc.endpoint, Protocol: tc.proto}
		_, err := New(cfg)
		if tc.shouldSucceed && err != nil {
			t.Errorf("expected success for %+v got %v", tc, err)
		}
		if !tc.shouldSucceed && err == nil {
			t.Errorf("expected failure for %+v", tc)
		}
	}
}

func TestParseIPPAttributesRealistic(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x41, "status-message", "successful-ok")
	buf.WriteByte(0x04)
	writeIPPIntAttr(&buf, 0x23, "printer-state", 3)
	writeIPPAttribute(&buf, 0x44, "printer-state-reasons", "none")
	buf.WriteByte(0x44)
	binary.Write(&buf, binary.BigEndian, uint16(0))
	media := "media-low"
	binary.Write(&buf, binary.BigEndian, uint16(len(media)))
	buf.WriteString(media)
	writeIPPBoolAttr(&buf, "printer-is-accepting-jobs", true)
	writeIPPAttribute(&buf, 0x42, "printer-name", "HP LaserJet")
	writeIPPAttribute(&buf, 0x45, "printer-uri", "ipp://192.168.1.60/ipp/print")
	writeIPPAttribute(&buf, 0x41, "printer-info", "Front desk")
	writeIPPIntAttr(&buf, 0x21, "copies-default", 1)
	writeIPPAttribute(&buf, 0x41, "vendor-extension", "ok")
	buf.WriteByte(0x03)

	attrs := parseIPPAttributes(buf.Bytes())
	if attrs["printer-state"] != "3" {
		t.Fatalf("printer-state=%q want 3", attrs["printer-state"])
	}
	if attrs["printer-is-accepting-jobs"] != "true" {
		t.Fatalf("accepting=%q", attrs["printer-is-accepting-jobs"])
	}
	if attrs["printer-name"] != "HP LaserJet" {
		t.Fatalf("name=%q", attrs["printer-name"])
	}
	if attrs["printer-uri"] != "ipp://192.168.1.60/ipp/print" {
		t.Fatalf("uri=%q", attrs["printer-uri"])
	}
	if attrs["printer-info"] != "Front desk" {
		t.Fatalf("info=%q", attrs["printer-info"])
	}
	if attrs["copies-default"] != "1" {
		t.Fatalf("copies=%q", attrs["copies-default"])
	}
	if !strings.Contains(attrs["printer-state-reasons"], "none") || !strings.Contains(attrs["printer-state-reasons"], "media-low") {
		t.Fatalf("reasons=%q", attrs["printer-state-reasons"])
	}
	if attrs["vendor-extension"] != "ok" {
		t.Fatalf("unknown attr dropped: %v", attrs)
	}
	status, msg := parseIPPStatus(buf.Bytes())
	if status != 0 {
		t.Fatalf("status 0x%04x", status)
	}
	if msg != "successful-ok" {
		t.Fatalf("status-message=%q", msg)
	}
}

func TestParseIPPAttributesMalformedNeverPanics(t *testing.T) {
	cases := [][]byte{
		nil,
		{},
		{0x02, 0x00},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01},
		append([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04, 0x21}, bytes.Repeat([]byte{0xff}, 8)...),
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x41, 0x00, 0x20},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x41, 0x00, 0x01, 'a', 0xFF, 0xFF},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x99, 0x00, 0x03, 'f', 'o', 'o', 0x00, 0x01, 0x01},
	}
	for i, c := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("case %d panicked: %v", i, r)
				}
			}()
			_ = parseIPPAttributes(c)
			_, _ = parseIPPStatus(c)
		}()
	}
}

func TestParseIPPAttributesMultiplePrinterGroups(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	buf.WriteByte(0x04)
	writeIPPIntAttr(&buf, 0x23, "printer-state", 4)
	buf.WriteByte(0x04)
	writeIPPAttribute(&buf, 0x44, "printer-state-reasons", "moving-to-paused")
	buf.WriteByte(0x03)
	attrs := parseIPPAttributes(buf.Bytes())
	if attrs["printer-state"] != "4" {
		t.Fatalf("state=%q", attrs["printer-state"])
	}
	if attrs["printer-state-reasons"] != "moving-to-paused" {
		t.Fatalf("reasons=%q", attrs["printer-state-reasons"])
	}
}

func TestIPPStatusUsesParsedPrinterState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		buf.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
		buf.WriteByte(0x01)
		writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
		writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
		buf.WriteByte(0x04)
		writeIPPIntAttr(&buf, 0x23, "printer-state", 3)
		writeIPPAttribute(&buf, 0x44, "printer-state-reasons", "none")
		writeIPPBoolAttr(&buf, "printer-is-accepting-jobs", true)
		buf.WriteByte(0x03)
		w.Header().Set("Content-Type", "application/ipp")
		w.Write(buf.Bytes())
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "State")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Status(); got != "online" {
		t.Fatalf("status=%q want online", got)
	}
}

func TestIPPPrintJobDoesNotEmbedHTTPBasicAuthCredentials(t *testing.T) {
	p, err := NewIPPPrinter("ipp://printuser:printpass@192.168.1.60/ipp/print", "Front Desk")
	if err != nil {
		t.Fatalf("NewIPPPrinter: %v", err)
	}
	if p.URL != "http://192.168.1.60:631/ipp/print" {
		t.Fatalf("normalized transport URL leaked or retained credentials: %q", p.URL)
	}
	if p.PrinterURI != "ipp://192.168.1.60:631/ipp/print" {
		t.Fatalf("normalized IPP printer URI leaked or retained credentials: %q", p.PrinterURI)
	}
	if p.creds == nil {
		t.Fatal("expected parsed credentials for HTTP Basic authentication")
	}
	if got := p.requestURL(); got != "http://192.168.1.60:631/ipp/print" {
		t.Fatalf("request URL retained credentials: %q", got)
	}
	payload := []byte("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	job := buildIPPPrintJobWithFormat(p.PrinterURI, payload, ippFormatPDF)
	if bytes.Contains(job, []byte("printuser")) || bytes.Contains(job, []byte("printpass")) {
		t.Fatal("IPP printer-uri payload must never contain HTTP Basic Auth credentials")
	}
	if !bytes.Contains(job, []byte("ipp://192.168.1.60:631/ipp/print")) {
		t.Fatal("IPP payload should retain the credential-free IPP printer URI")
	}
}

func writeIPPIntAttr(buf *bytes.Buffer, tag byte, name string, value int32) {
	buf.WriteByte(tag)
	binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	binary.Write(buf, binary.BigEndian, uint16(4))
	binary.Write(buf, binary.BigEndian, value)
}

func writeIPPBoolAttr(buf *bytes.Buffer, name string, value bool) {
	buf.WriteByte(0x22)
	binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	binary.Write(buf, binary.BigEndian, uint16(1))
	if value {
		buf.WriteByte(0x01)
	} else {
		buf.WriteByte(0x00)
	}
}

func containsBytes(b, sub []byte) bool {
	for i := 0; i <= len(b)-len(sub); i++ {
		if string(b[i:i+len(sub)]) == string(sub) {
			return true
		}
	}
	return false
}

func bytesHasSuffix(b, suffix []byte) bool {
	if len(suffix) > len(b) {
		return false
	}
	return string(b[len(b)-len(suffix):]) == string(suffix)
}

func readAll(r interface{ Read([]byte) (int, error) }) []byte {
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
		if n == 0 {
			break
		}
	}
	return buf
}

func validTestPDFBytes() []byte {
	return []byte("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
}

// TestParseIPPAttributesNeverPanicsOnMalformedInput exercises the recovery guard
// over truncated/garbage inputs. Before this pass the guard was a bare
// `_ = recover()`, so this test could not tell a swallowed panic from a clean
// return; it now also pins the observable side of the guard.
func TestParseIPPAttributesNeverPanicsOnMalformedInput(t *testing.T) {
	inputs := [][]byte{
		nil,
		{},
		{0x02},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01},
		append([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x47}, make([]byte, 4)...),
		append([]byte{0x02, 0, 0, 0, 0, 0, 0, 1, 0x47, 0x00, 0xFF, 0xFF, 0x00}, 0x41),
		append([]byte{0x02, 0, 0, 0, 0, 0, 0, 1, 0x48, 0x00, 0x01, 'a', 0xFF, 0xFF}, 0x42),
	}
	for i, in := range inputs {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("input %d: parseIPPAttributes panicked out of the guard: %v", i, r)
				}
			}()
			if got := parseIPPAttributes(in); got == nil {
				t.Fatalf("input %d: expected non-nil map", i)
			}
		}()
	}
}

// TestLogRecoveredIPPParseReportsPanic covers the reporter helper added in this
// pass: the recovered panic value and the input length must reach the log.
//
// NOTE: this test alone does NOT pin the guard in parseIPPAttributes — it calls
// the helper directly, so it still passes if the deferred closure is reverted to
// a bare `_ = recover()`. That was measured, not assumed. The guard itself is
// pinned separately by TestIPPParseGuardReportsRecoveredPanics below.
func TestLogRecoveredIPPParseReportsPanic(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	logRecoveredIPPParse(37, "runtime error: slice bounds out of range")

	out := buf.String()
	if !strings.Contains(out, "recovered from malformed IPP attributes") {
		t.Fatalf("expected a recovery warning, got %q", out)
	}
	if !strings.Contains(out, "len=37") {
		t.Fatalf("expected the input length in the warning, got %q", out)
	}
	if !strings.Contains(out, "slice bounds out of range") {
		t.Fatalf("expected the recovered value in the warning, got %q", out)
	}
}

// TestIPPParseGuardReportsRecoveredPanics pins the GUARD, not the helper: the
// deferred closure in parseIPPAttributes must pass a recovered panic to the
// reporter. A regression to the pre-fix `defer func() { _ = recover() }()` makes
// this test fail.
//
// Why a source contract instead of a behavioural test: the panic path is
// currently unreachable. Every slice in parseIPPAttributes and decodeIPPValue is
// length-checked before use, so no input (including the truncated/lying-length
// cases below) makes the parser panic. The guard is defensive hardening for
// bytes taken straight off the network, and the only way to prove it still
// REPORTS is to assert the reporting call is present.
func TestIPPParseGuardReportsRecoveredPanics(t *testing.T) {
	source, err := os.ReadFile("ipp.go")
	if err != nil {
		t.Fatalf("read ipp.go: %v", err)
	}
	text := string(source)

	start := strings.Index(text, "func parseIPPAttributes(")
	if start < 0 {
		t.Fatal("parseIPPAttributes not found in ipp.go")
	}
	rest := text[start:]
	if end := strings.Index(rest[1:], "\nfunc "); end >= 0 {
		rest = rest[:end+1]
	}

	if !strings.Contains(rest, "if r := recover(); r != nil {") {
		t.Error("parseIPPAttributes no longer inspects the recovered value; a bare recover() makes parser panics invisible again")
	}
	if !strings.Contains(rest, "logRecoveredIPPParse(len(data), r)") {
		t.Error("the recovered panic is not reported by logRecoveredIPPParse; recovery is silent again")
	}
	if strings.Contains(rest, "_ = recover()") {
		t.Error("the bare `_ = recover()` form is back, which discards the panic without a trace")
	}
}
