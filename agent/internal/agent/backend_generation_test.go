package agent

import (
	"context"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// liveSessionStub is a test backend whose transport session can be held
// "live" across calls, simulating a wedged Win32 worker or abandoned kernel
// write that outlives its caller's return.
type liveSessionStub struct {
	fakePrinter
	live bool
}

func (s *liveSessionStub) SessionMayBeLive() bool { return s.live }

var _ printer.LiveSessionReporter = (*liveSessionStub)(nil)

func TestAddPrinterDefersReplacementWhileSessionLive(t *testing.T) {
	old := &liveSessionStub{live: true}
	ag := newTestAgent(t, "p1", old)
	changed := config.PrinterConfig{ID: "p1", Name: "Test", Type: "network", Endpoint: "127.0.0.1:9101", Protocol: "raw"}
	if ag.addPrinter("p1", &fakePrinter{}, changed) {
		t.Fatal("backend replacement must defer while a prior session may still own the transport")
	}
	ag.printersMu.RLock()
	kept, _ := ag.printers["p1"]
	keptCfg := ag.printerConfigs["p1"]
	ag.printersMu.RUnlock()
	if kept != printer.Printer(old) {
		t.Fatal("deferred replacement must keep the old backend object")
	}
	if keptCfg.Endpoint != "127.0.0.1:9100" {
		t.Fatalf("deferred replacement must keep old facts, got endpoint %q", keptCfg.Endpoint)
	}
	old.live = false
	if !ag.addPrinter("p1", &fakePrinter{}, changed) {
		t.Fatal("backend replacement must proceed once the prior session drains")
	}
}

func TestApplyDesiredPrinterDefersWhileSessionLive(t *testing.T) {
	old := &liveSessionStub{live: true}
	ag := newTestAgent(t, "p1", old)
	row := desiredPrinterRecord{Desired: desiredPrinterWire{
		ID: "p1", Name: "Receipt p1", PrinterType: "physical", DeviceClass: "thermal",
		ConnectionType: "network", Protocol: "raw", Lifecycle: "active",
		Config:          map[string]interface{}{"ip": "192.168.2.10", "port": 9100},
		DesiredRevision: 2,
	}}
	if err := ag.applyDesiredPrinter(row); err == nil {
		t.Fatal("desired apply must defer while a prior session may still own the transport")
	}
	ag.printersMu.RLock()
	kept, _ := ag.printers["p1"]
	ag.printersMu.RUnlock()
	if kept != printer.Printer(old) {
		t.Fatal("deferred desired apply must keep the old backend object")
	}
	old.live = false
	if err := ag.applyDesiredPrinter(row); err != nil {
		t.Fatalf("desired apply must proceed once the session drains: %v", err)
	}
}

func TestWatchSpoolerJobIDPersistsMidPhaseEvidence(t *testing.T) {
	p := &fakePrinter{spoolerID: "555"}
	ag := newTestAgent(t, "p1", p)
	if err := ag.queue.Push("watch-1", "p1", []byte("x")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := ag.queue.BeginPrint("watch-1", "p1", []byte("x"), "claim-watch", false); err != nil {
		t.Fatalf("BeginPrint: %v", err)
	}
	// Mid-phase observation (as during hardware dispatch), then dispatch end.
	ctx, evidence := printer.WithSpoolerJobEvidence(context.Background())
	printer.RecordSpoolerJobID(ctx, 555)
	stop := ag.watchSpoolerJobID("watch-1", evidence)
	stop()
	// A crash after StartDoc but before the terminal write must still leave
	// the platform identity for recovery: read it through the crash path.
	marked, err := ag.queue.MarkInterrupted()
	if err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}
	if len(marked) != 1 || marked[0].SpoolerJobID != "555" {
		t.Fatalf("mid-phase platform identity lost: %+v", marked)
	}
}

func TestResolvePrinterAliasRecoversLocalBackend(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_net_abcdef12", p)
	if got := ag.resolvePrinterAlias("printer_net_abcdef12"); got != "printer_net_abcdef12" {
		t.Fatalf("exact local ID must win, got %q", got)
	}
	if got := ag.resolvePrinterAlias("printer_net_abcdef12~1234abcd"); got != "printer_net_abcdef12" {
		t.Fatalf("gateway alias must resolve to the local backend, got %q", got)
	}
	if got := ag.resolvePrinterAlias("printer_net_abcdef12~ZZZZZZZZ"); got != "printer_net_abcdef12~ZZZZZZZZ" {
		t.Fatalf("malformed suffix must pass through, got %q", got)
	}
	if got := ag.resolvePrinterAlias("printer_net_99999999~1234abcd"); got != "printer_net_99999999~1234abcd" {
		t.Fatalf("alias of an unknown printer must pass through, got %q", got)
	}
	if got := ag.resolvePrinterAlias("printer_net_abcdef12~1234abc"); got != "printer_net_abcdef12~1234abc" {
		t.Fatalf("short suffix must pass through, got %q", got)
	}
}
