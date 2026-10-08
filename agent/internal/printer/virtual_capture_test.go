package printer

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestYAMLVirtualCaptureProvenanceFlowsToHeartbeat(t *testing.T) {
	pc := virtualFixture()
	tagged := TagConfiguredVirtualCapture(pc)
	if got := tagged.Capabilities["registration_source"]; got != "config" {
		t.Fatalf("Gateway requires trusted YAML source marker, got %v", got)
	}
	if _, originalMutated := pc.Capabilities["registration_source"]; originalMutated {
		t.Fatal("source marker must not mutate shared YAML capability map")
	}
	regular := virtualFixture()
	regular.SpoolerName = "Microsoft Print to PDF"
	regularTagged := TagConfiguredVirtualCapture(regular)
	if _, marked := regularTagged.Capabilities["registration_source"]; marked {
		t.Fatal("ordinary virtual Windows queue cannot be tagged as Yaseir capture")
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

func TestVirtualCaptureQuotaIsAtomicWithConcurrentJobs(t *testing.T) {
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_MODE", "1")
	dir := t.TempDir()
	t.Setenv("YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR", dir)
	p, err := NewVirtualCapturePrinter(virtualFixture())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < virtualCaptureMaxFiles-1; i++ {
		name := filepath.Join(dir, fmt.Sprintf("virtual-existing-%03d.raw", i))
		if err := os.WriteFile(name, []byte("old"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, jobID := range []string{"job_A", "job_B"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			errs <- p.PrintDocument(context.Background(), Document{Kind: KindRaw, JobID: id, Data: []byte("new")})
		}(jobID)
	}
	wg.Wait()
	close(errs)
	ok, rejected := 0, 0
	for err := range errs {
		if err == nil {
			ok++
		} else {
			rejected++
		}
	}
	if ok != 1 || rejected != 1 {
		t.Fatalf("exactly one of two competing jobs may claim the last capture slot: ok=%d rejected=%d", ok, rejected)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != virtualCaptureMaxFiles {
		t.Fatalf("capture quota bypassed: got %d, want %d", len(files), virtualCaptureMaxFiles)
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
