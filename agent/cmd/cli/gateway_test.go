package main

import (
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
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
		{"fleet malformed query", "/api/printers?limit", "GET", false},
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
		{"jobs unknown query", "/api/jobs?evil=x", "GET", false},
		{"jobs malformed query", "/api/jobs?limit", "GET", false},
		{"list agents", "/api/agents", "GET", true},
		{"read own E2E inbox", "/api/agent/test-captures/status", "GET", true},
		{"read one E2E preview", "/api/agent/test-captures/preview?id=cap_" + strings.Repeat("a", 32), "GET", true},
		{"do not claim E2E jobs through console", "/api/agent/test-captures", "GET", false},
		{"do not report E2E results through console", "/api/agent/test-captures", "PATCH", false},
		{"no inbox mutation", "/api/agent/test-captures/status", "POST", false},
		{"clear completed E2E evidence", "/api/agent/test-captures/status", "DELETE", true},
		{"no capture API deletion", "/api/agent/test-captures", "DELETE", false},
		{"no preview deletion", "/api/agent/test-captures/preview?id=cap_" + strings.Repeat("a", 32), "DELETE", false},
		{"no captured inbox deletion with query", "/api/agent/test-captures/status?all=1", "DELETE", false},
		{"no other query on inbox", "/api/agent/test-captures/status?id=x", "GET", false},
		{"reject invalid E2E id", "/api/agent/test-captures/preview?id=cap_" + strings.Repeat("A", 32), "GET", false},
		{"reject E2E preview query injection", "/api/agent/test-captures/preview?id=cap_" + strings.Repeat("a", 32) + "&evil=1", "GET", false},
		{"get agent", "/api/agents/agent-1", "GET", true},
		{"create printer", "/api/printers", "POST", true},
		{"test connection", "/api/printers/p1/test-connection", "POST", true},
		{"agent self test-print", "/api/printers/p1/test-print", "POST", true},
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
		{"https://print.example.com:443", "https://print.example.com/", false},
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
