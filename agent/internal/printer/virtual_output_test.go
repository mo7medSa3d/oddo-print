package printer

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestIsPromptingVirtualPort(t *testing.T) {
	cases := []struct {
		port string
		want bool
	}{
		{"PORTPROMPT:", true},
		{"portprompt:", true},
		{"FILE:", true},
		{"XPSPORT:", true},
		{"USB001", false},
		{"192.168.1.50", false},
		{`C:\prints\fixed.pdf`, false},
		{"", false},
	}
	for _, tc := range cases {
		if got := isPromptingVirtualPort(tc.port); got != tc.want {
			t.Errorf("isPromptingVirtualPort(%q) = %v, want %v", tc.port, got, tc.want)
		}
	}
}

func TestBuildVirtualOutputPath(t *testing.T) {
	fixedNow := time.Date(2026, 11, 22, 18, 30, 0, 0, time.UTC)

	pdfPath := buildVirtualOutputPath("/tmp/out", "PORTPROMPT:", "Microsoft Print To PDF", "Microsoft Print to PDF", "job-42", fixedNow)
	if !strings.HasSuffix(pdfPath, ".pdf") || !strings.Contains(filepath.Base(pdfPath), "job-42") {
		t.Fatalf("unexpected PDF output path: %q", pdfPath)
	}

	xpsPath := buildVirtualOutputPath("/tmp/out", "XPSPORT:", "Microsoft XPS Document Writer v4", "Microsoft XPS Document Writer", "job-99", fixedNow)
	if !strings.HasSuffix(xpsPath, ".xps") {
		t.Fatalf("unexpected XPS output path: %q", xpsPath)
	}

	rawPath := buildVirtualOutputPath("/tmp/out", "FILE:", "Generic / Text Only", "Print to File", "", fixedNow)
	if !strings.HasSuffix(rawPath, ".prn") {
		t.Fatalf("unexpected FILE: output path: %q", rawPath)
	}

	if phys := buildVirtualOutputPath("/tmp/out", "USB001", "EPSON TM-T88V", "POS Printer", "job-1", fixedNow); phys != "" {
		t.Fatalf("physical printer must not receive a virtual output path, got %q", phys)
	}
}

func TestFactoryAllowsPrintableVirtualAndRejectsRedirectedOrTestSinks(t *testing.T) {
	redirected := config.PrinterConfig{
		ID:          "redir-1",
		Name:        "HP LaserJet (redirected 2)",
		Type:        "spooler",
		Protocol:    "spooler",
		SpoolerName: "HP LaserJet (redirected 2)",
		PrinterType: "redirected",
	}
	if _, err := New(redirected); err == nil {
		t.Fatal("factory accepted redirected printer")
	}

	testSink := config.PrinterConfig{
		ID:           "sink-1",
		Name:         "Test Sink",
		Type:         "spooler",
		Protocol:     "spooler",
		SpoolerName:  "Test Sink",
		Capabilities: map[string]interface{}{"virtual_test_sink": true},
	}
	if _, err := New(testSink); err == nil {
		t.Fatal("factory accepted virtual_test_sink")
	}

	pdf := config.PrinterConfig{
		ID:          "virt-pdf",
		Name:        "Microsoft Print to PDF",
		Type:        "spooler",
		Protocol:    "spooler",
		SpoolerName: "Microsoft Print to PDF",
		PrinterType: "virtual",
	}
	_, err := New(pdf)
	if err != nil && strings.Contains(err.Error(), "not supported") {
		t.Fatalf("factory rejected printable virtual printer as unsupported: %v", err)
	}
}
