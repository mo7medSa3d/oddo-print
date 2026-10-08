package printer

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func virtualFixture() config.PrinterConfig {
	return config.PrinterConfig{
		ID: "yaseir_virtual_test", Name: "Yaseir Virtual Test Printer",
		Type: "spooler", Protocol: "spooler",
		SpoolerName: VirtualCaptureSpoolerName, PrinterType: "virtual",
		Capabilities: map[string]interface{}{"virtual_test_sink": true, "supported_protocols": []string{"pdf", "raw", "escpos"}},
	}
}

func TestVirtualPrinterIsOptInAndNeverProduction(t *testing.T) {
	pc := virtualFixture()
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_MODE", "0")
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR", t.TempDir())
	if _, err := New(pc); err == nil {
		t.Fatal("must refuse virtual capture without explicit agent test flag")
	}
	di := DeviceInfo{
		ID: pc.ID, Name: pc.Name, ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: pc.SpoolerName, PrinterType: "virtual",
		Capabilities: map[string]interface{}{"virtual_test_sink": true, "registration_source": "config"},
	}
	if IsProductionPrinter(di) || IsManagedPrinter(di) {
		t.Fatal("virtual must stay out of production and disabled inventory")
	}
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_MODE", "1")
	if !IsManagedPrinter(di) || IsProductionPrinter(di) {
		t.Fatal("opted-in virtual capture should be test-managed, never production")
	}
	if err := config.ValidatePrinterConfig(pc); err != nil {
		t.Fatalf("synthetic config invalid: %v", err)
	}
	// Legacy virtual software writers, fax queues and redirected sessions
	// must remain hidden even when test mode is active.
	for _, name := range []string{"Microsoft Print to PDF", "Canon G4070 series FAX", "HP LaserJet (redirected 2)"} {
		di.Name, di.SpoolerName = name, name
		di.Capabilities = map[string]interface{}{"port_name": "PORTPROMPT:", "registration_source": "config"}
		if IsManagedPrinter(di) {
			t.Fatalf("arbitrary virtual writer %q leaked into managed inventory", name)
		}
	}
}

func TestVirtualCaptureCreatesInspectableBytesForAgentTest(t *testing.T) {
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_MODE", "1")
	dir := filepath.Join(t.TempDir(), "VirtualCaptures")
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR", dir)
	pc := virtualFixture()
	p, err := New(pc)
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Status(); got != "online" {
		t.Fatalf("capture status %q", got)
	}
	pdf := validPDF()
	if err := PrintDocument(context.Background(), p, Document{Kind: KindPDF, Data: pdf, JobID: "job_fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := PrintDocument(context.Background(), p, Document{Kind: KindESCPOS, Data: []byte{0x1b, 0x40, 'O', 'K'}, JobID: "../unsafe"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 capture artifacts, got %d", len(entries))
	}
	var pdfFound, escposFound bool
	for _, entry := range entries {
		body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(entry.Name(), ".pdf") {
			pdfFound = bytes.Equal(body, pdf) && strings.Contains(entry.Name(), "job_fixture")
		}
		if strings.HasSuffix(entry.Name(), ".escpos") {
			escposFound = bytes.Equal(body, []byte{0x1b, 0x40, 'O', 'K'}) && !strings.Contains(entry.Name(), "unsafe")
		}
	}
	if !pdfFound || !escposFound {
		t.Fatalf("capture content or filename is wrong: pdf=%t escpos=%t", pdfFound, escposFound)
	}
	if err := p.Test(context.Background()); err != nil {
		t.Fatalf("local virtual test failed: %v", err)
	}
}

func TestVirtualCaptureFailsClosedForInvalidOutputAndPayloads(t *testing.T) {
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_MODE", "1")
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR", "relative-path")
	if _, err := New(virtualFixture()); err == nil {
		t.Fatal("relative capture output must not be allowed")
	}
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR", t.TempDir())
	pc := virtualFixture()
	pc.PrinterType = "physical"
	if _, err := New(pc); err == nil {
		t.Fatal("physical declaration must not execute reserved virtual sink")
	}
	pc = virtualFixture()
	delete(pc.Capabilities, "virtual_test_sink")
	if _, err := New(pc); err == nil {
		t.Fatal("capture without exact capability marker must fail")
	}
	p, err := New(virtualFixture())
	if err != nil {
		t.Fatal(err)
	}
	if err := PrintDocument(context.Background(), p, Document{Kind: KindPDF, Data: []byte("bad"), JobID: "job_bad"}); err == nil {
		t.Fatal("invalid PDF must never report success")
	}
	if err := PrintDocument(context.Background(), p, Document{Kind: KindRaw, Data: make([]byte, maxPrintBytes+1)}); err == nil {
		t.Fatal("overlimit capture must reject payload")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := PrintDocument(ctx, p, Document{Kind: KindRaw, Data: []byte("test")}); err == nil {
		t.Fatal("cancelled test must not write a file")
	}
}
