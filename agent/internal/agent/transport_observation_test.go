package agent

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type observedTransportPrinter struct {
	fakePrinter
	observed bool
}

func (p *observedTransportPrinter) TransportObserved() bool { return p.observed }

func TestRediscoveryReplacementClearsEarlierHealthCache(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	first := config.PrinterConfig{ID: "rediscovered", Name: "rediscovered", Type: "network", Endpoint: "192.168.2.39:9100"}
	if !a.addPrinter(first.ID, &fakePrinter{}, first) {
		t.Fatal("initial registration failed")
	}
	a.setProbeLastStatus(first.ID, "offline")
	second := first
	second.Endpoint = "192.168.2.40:9100"
	if !a.addPrinter(first.ID, &fakePrinter{}, second) {
		t.Fatal("updated endpoint registration failed")
	}
	if got := a.probeLastStatus(first.ID); got != "unknown" {
		t.Fatalf("rediscovery retained earlier endpoint's %q health", got)
	}
}

var _ printer.TransportObservationReporter = (*observedTransportPrinter)(nil)
