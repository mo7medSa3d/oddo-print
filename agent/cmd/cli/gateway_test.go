package main

import (
	"os"
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
		{"list jobs", "/api/jobs", "GET", true},
		{"list jobs with limit", "/api/jobs?limit=50", "GET", true},
		{"list jobs with search", "/api/jobs?limit=50&search=invoice", "GET", true},
		{"jobs unknown query", "/api/jobs?evil=x", "GET", false},
		{"jobs malformed query", "/api/jobs?limit", "GET", false},
		{"list agents", "/api/agents", "GET", true},
		{"get agent", "/api/agents/agent-1", "GET", true},
		{"create printer", "/api/printers", "POST", true},
		{"test connection", "/api/printers/p1/test-connection", "POST", true},
		{"test print", "/api/printers/p1/test-print", "POST", true},
		{"patch printer", "/api/printers/p1", "PATCH", true},
		{"delete printer", "/api/printers/p1", "DELETE", false},
		{"branch endpoint", "/api/branches", "GET", false},
		{"external url", "https://example.com/api/printers", "GET", false},
		{"path traversal", "/api/printers/../agents", "GET", false},
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
