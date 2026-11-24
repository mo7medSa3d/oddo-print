package main

import (
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestAllowedGatewayConsolePath(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		method string
		want   bool
	}{
		{"list printers", "/api/printers", "GET", true},
		{"list printers after cursor", "/api/printers?limit=1000&beforeCreatedAt=2026-10-13T12%3A00%3A00Z&beforeId=printer-2", "GET", true},
		{"list agents after cursor", "/api/agents?beforeCreatedAt=2026-10-13T12%3A00%3A00Z&beforeId=agent-2", "GET", true},
		{"list Unicode printer cursor", "/api/printers?beforeCreatedAt=2026-10-13T12%3A00%3A00Z&beforeIdEncoded=cHJpbnRlci3Yow", "GET", true},
		{"list long encoded cursor", "/api/printers?beforeIdEncoded=" + strings.Repeat("x", 2732), "GET", true},
		{"list agents offset", "/api/agents?limit=10&offset=10", "GET", true},
		{"fleet duplicate query", "/api/printers?limit=10&limit=1000", "GET", false},
		{"fleet unknown query", "/api/printers?secret=x", "GET", false},
		{"fleet percent-escaped query key alias", "/api/printers?l%69mit=100", "GET", false},
		{"fleet malformed query", "/api/printers?limit", "GET", false},
		{"fleet empty query marker", "/api/printers?", "GET", false},
		{"fleet empty fragment marker", "/api/agents#", "GET", false},
		{"fleet empty fragment after query", "/api/printers?limit=10#", "GET", false},
		{"fleet invalid escape", "/api/printers?beforeId=%zz", "GET", false},
		{"fleet empty query value", "/api/printers?beforeId=", "GET", false},
		{"fleet trailing query separator", "/api/printers?limit=10&", "GET", false},
		{"fleet oversized cursor", "/api/printers?beforeId=" + strings.Repeat("x", 4097), "GET", false},
		{"fleet fragment", "/api/printers?limit=10#other", "GET", false},
		{"fleet encoded route", "/api/%70rinters?limit=10", "GET", false},
		{"fleet write query", "/api/printers?limit=10", "POST", false},
		{"list jobs", "/api/jobs", "GET", true},
		{"list jobs with limit", "/api/jobs?limit=50", "GET", true},
		{"list jobs with search", "/api/jobs?limit=50&search=invoice", "GET", true},
		{"jobs literal dots are search data", "/api/jobs?search=invoice..pdf", "GET", true},
		{"fleet cursor literal dots are data", "/api/printers?beforeId=printer..queue", "GET", true},
		{"jobs unknown query", "/api/jobs?evil=x", "GET", false},
		{"jobs encoded query key alias", "/api/jobs?se%61rch=receipt", "GET", false},
		{"jobs malformed query", "/api/jobs?limit", "GET", false},
		{"jobs valid encoded Unicode search", "/api/jobs?search=receipt+%D8%A3", "GET", true},
		{"jobs valid encoded fragment literal", "/api/jobs?search=a%23b", "GET", true},
		{"jobs duplicate query key", "/api/jobs?limit=10&limit=20", "GET", false},
		{"jobs invalid percent escape", "/api/jobs?search=%ZZ", "GET", false},
		{"jobs invalid escaped hidden unknown query", "/api/jobs?status=queued&evil=%ZZ", "GET", false},
		{"jobs empty query marker", "/api/jobs?", "GET", false},
		{"jobs absolute URL", "https://attacker.example/api/jobs", "GET", false},
		{"jobs protocol-relative URL", "//attacker.example/api/jobs", "GET", false},
		{"jobs empty fragment marker", "/api/jobs#", "GET", false},
		{"jobs empty fragment after query", "/api/jobs?status=queued#", "GET", false},
		{"list agents", "/api/agents", "GET", true},
		{"removed E2E capture route", "/api/agent/test-captures/status", "GET", false},
		{"removed E2E capture delete route", "/api/agent/test-captures/status", "DELETE", false},
		{"get agent", "/api/agents/agent-1", "GET", true},
		{"create printer", "/api/printers", "POST", true},
		{"test connection", "/api/printers/p1/test-connection", "POST", true},
		{"agent self test-print", "/api/printers/p1/test-print", "POST", true},
		{"Arabic printer ID", "/api/printers/%D8%B7%D8%A7%D8%A8%D8%B9%D8%A9~1234abcd/test-print", "POST", true},
		{"spaced printer ID", "/api/printers/Receipt%20Printer/test-print", "POST", true},
		{"Arabic connection", "/api/printers/%D8%B7%D8%A7%D8%A8%D8%B9%D8%A9/test-connection", "POST", true},
		{"interior encoded BOM remains exact ID", "/api/printers/pr%EF%BB%BFinter/test-print", "POST", true},
		{"leading encoded BOM must not select printer", "/api/printers/%EF%BB%BFprinter/test-print", "POST", false},
		{"trailing encoded BOM must not select printer", "/api/printers/printer%EF%BB%BF/test-print", "POST", false},
		{"encoded slash", "/api/printers/p%2Fother/test-print", "POST", false},
		{"encoded backslash", "/api/printers/p%5Cother/test-print", "POST", false},
		{"encoded query", "/api/printers/p%3Fother/test-print", "POST", false},
		{"double encoding", "/api/printers/p%252Fother/test-print", "POST", false},
		{"escaped traversal", "/api/printers/%2E%2E/test-print", "POST", false},
		{"noncanonical ASCII", "/api/printers/p%70/test-print", "POST", false},
		{"lowercase escapes", "/api/printers/%d8%b7/test-print", "POST", false},
		{"invalid UTF8", "/api/printers/%FF/test-print", "POST", false},
		{"encoded control", "/api/printers/Bad%00Name/test-print", "POST", false},
		{"invalid percent", "/api/printers/p%ZZ/test-print", "POST", false},
		{"oversized printer ID", "/api/printers/" + strings.Repeat("p", 121) + "/test-print", "POST", false},
		{"patch printer is manager-only", "/api/printers/p1", "PATCH", false},
		{"delete printer", "/api/printers/p1", "DELETE", false},
		{"branch endpoint", "/api/branches", "GET", false},
		{"external url", "https://example.com/api/printers", "GET", false},
		{"path traversal", "/api/printers/../agents", "GET", false},
		{"test-print target traversal", "/api/printers/../test-print", "POST", false},
		{"test-print query injection", "/api/printers/p1/test-print?x=1", "POST", false},
		{"printer suffix spoof", "/api/printers/p1/test-print/extra", "POST", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isAllowedGatewayConsolePath(tt.path, tt.method); got != tt.want {
				t.Fatalf("isAllowedGatewayConsolePath(%q, %q) = %v, want %v", tt.path, tt.method, got, tt.want)
			}
		})
	}
}

func TestGatewayRequestCLIUsesExplicitConfigPath(t *testing.T) {
	source := readGatewaySourceForTest(t)
	if !strings.Contains(source, `fs.String("config", configPath, "Path to the paired agent config file")`) {
		t.Fatal("gateway-request must accept the explicit -config path used by the Tauri desktop")
	}
	if !strings.Contains(source, "config.Load(*configOverride)") {
		t.Fatal("gateway-request must load the explicitly supplied agent config")
	}
}

func readGatewaySourceForTest(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("gateway.go")
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestValidateManualPrinterTransport(t *testing.T) {
	if err := validateManualPrinterTransport("usb", "", ""); err == nil {
		t.Fatal("direct USB must require an explicit Windows device path")
	}
	if err := validateManualPrinterTransport("usb", `\\?\usb#vid_03f0&pid_0c17#SN123`, ""); err != nil {
		t.Fatalf("valid direct USB device path rejected: %v", err)
	}
	if err := validateManualPrinterTransport("usb", "", "Receipt Printer"); err != nil {
		t.Fatalf("USB spooler-backed printer should accept spooler name: %v", err)
	}
	if err := validateManualPrinterTransport("spooler", "", "Receipt Printer"); err != nil {
		t.Fatalf("spooler printer should accept spooler name: %v", err)
	}
}

func TestNormalizeOriginForCompare(t *testing.T) {
	cases := []struct {
		a, b  string
		equal bool
	}{
		{"https://print.example.com", "https://print.example.com/", true},
		{"https://print.example.com/", "HTTPS://PRINT.EXAMPLE.COM", true},
		// The CLI origin fence deliberately strips scheme-default ports
		// (v3): https://host:443 names the same origin as https://host,
		// so an explicit :443 in a paired config must not report a
		// mismatch. Only a non-default port still distinguishes.
		{"https://print.example.com:443", "https://print.example.com/", true},
		{"http://print.example.com:80", "http://print.example.com/", true},
		{"https://print.example.com:8443", "https://print.example.com/", false},
		{"https://print.example.com", "https://other.example.com", false},
		{"", "", true},
		{"https://print.example.com", "", false},
	}
	for _, tc := range cases {
		if got := normalizeOriginForCompare(tc.a) == normalizeOriginForCompare(tc.b); got != tc.equal {
			t.Fatalf("origin compare %q vs %q = %v, want %v", tc.a, tc.b, got, tc.equal)
		}
	}
}

func TestGatewayPaginationHeadersPreserveOnlyFleetMetadata(t *testing.T) {
	headers := make(http.Header)
	want := map[string]string{
		"x-has-more": "true", "x-next-before-created-at": "2026-10-13T12:00:00Z",
		"x-next-before-id-encoded": "printer-%D8%A3", "x-next-before-id": "printer-2", "x-next-cursor": "cursor",
	}
	for key, value := range want {
		headers.Set(key, value)
	}
	headers.Set("Set-Cookie", "private-session")
	headers.Set("Authorization", "private-token")
	headers.Set("X-Runtime-Secret", "private-runtime-token")
	if got, err := gatewayPaginationHeaders(headers); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("console pagination headers missing or private headers exposed: %v err=%v", got, err)
	}
	if got, err := gatewayPaginationHeaders(http.Header{}); err != nil || got != nil {
		t.Fatalf("legacy response must omit absent pagination headers: %v err=%v", got, err)
	}
}

func TestGatewayPaginationHeaderValuesAreBoundedWithoutTruncation(t *testing.T) {
	headers := make(http.Header)
	headers.Set("X-Has-More", "true")
	for _, key := range []string{"X-Next-Before-Created-At", "X-Next-Before-Id-Encoded", "X-Next-Before-Id", "X-Next-Cursor"} {
		t.Run(key, func(t *testing.T) {
			headers.Set(key, strings.Repeat("x", gatewayPaginationHeaderMaxBytes))
			if got, err := gatewayPaginationHeaders(headers); err != nil || got[strings.ToLower(key)] != headers.Get(key) || got["x-has-more"] != "true" {
				t.Fatalf("exact-bound cursor was truncated/dropped or unrelated metadata lost: %v err=%v", got, err)
			}
			headers.Set(key, strings.Repeat("x", gatewayPaginationHeaderMaxBytes+1))
			if got, err := gatewayPaginationHeaders(headers); err == nil || got != nil {
				t.Fatalf("oversized cursor was silently dropped/truncated or returned partial metadata: %v err=%v", got, err)
			}
			headers.Del(key)
		})
	}
	headers.Set("X-Has-More", strings.Repeat("x", gatewayPaginationHeaderMaxBytes+1))
	if got, err := gatewayPaginationHeaders(headers); err == nil || got != nil {
		t.Fatalf("oversized metadata must be rejected, never silently dropped/truncated: %v err=%v", got, err)
	}
	headers.Del("X-Has-More")
	headers.Set("Set-Cookie", strings.Repeat("private", gatewayPaginationHeaderMaxBytes))
	if got, err := gatewayPaginationHeaders(headers); err != nil || got != nil {
		t.Fatalf("nonallowlisted private headers must not enter the envelope or alter accepted fleet metadata: %v err=%v", got, err)
	}
}

func TestPrinterDiagnosticPreservesEncodedIDAndOrigin(t *testing.T) {
	path := "/api/printers/%D8%B7%D8%A7%D8%A8%D8%B9%D8%A9~1234abcd/test-print"
	if !isAllowedGatewayConsolePath(path, "POST") {
		t.Fatal("paired Agent rejected Unicode printer ID")
	}
	target, err := config.OdooEndpoint("https://print.example.com", path)
	if err != nil || target != "https://print.example.com"+path {
		t.Fatalf("Gateway origin or printer identity was modified: %q %v", target, err)
	}
}
