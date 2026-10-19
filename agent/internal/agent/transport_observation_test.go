package agent

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/printer"
)

type observedTransportPrinter struct {
	fakePrinter
	observed bool
}

func (p *observedTransportPrinter) TransportObserved() bool { return p.observed }

func TestUnknownObservedTransportAdvancesConfigWithoutInventingHealth(t *testing.T) {
	for _, connection := range []string{"spooler", "usb"} {
		for _, observed := range []bool{false, true} {
			t.Run(connection+map[bool]string{true: "-observed", false: "-unreadable"}[observed], func(t *testing.T) {
				a := newDesiredStateTestAgent(t)
				a.desiredStateSynced = true
				desired := testDesiredPrinter("present", 5, "active")
				desired.ConnectionType = connection
				desired.Protocol = map[string]string{"spooler": "spooler", "usb": "raw"}[connection]
				desired.Config = map[string]interface{}{"address": `\\?\USB#TEST`}
				if connection == "spooler" {
					desired.Config = map[string]interface{}{"address": "Real Queue", "spooler_name": "Real Queue"}
				}
				row := desiredPrinterRecord{Desired: desired, AppliedDesiredRevision: 5}
				pc := desiredPrinterConfig(row)
				backend := &observedTransportPrinter{observed: observed}
				a.printers[desired.ID] = backend
				a.printerConfigs[desired.ID] = pc
				a.desiredStates[desired.ID] = row
				if !a.recordPrinterProbeResult(desired.ID, pc, backend, "unknown") {
					t.Fatal("current-config probe unexpectedly discarded")
				}
				if got := a.isPrinterExecutionAllowed(desired.ID); got != observed {
					t.Fatalf("execution allowed=%v for observed=%v", got, observed)
				}
				if got := a.probeLastStatus(desired.ID); got != "unknown" {
					t.Fatalf("configuration evidence changed physical health to %q", got)
				}
			})
		}
	}
}

func TestOldProbeCannotObserveReplacementRuntimeOrDesiredConfig(t *testing.T) {
	for _, replacementApplied := range []bool{false, true} {
		a := newDesiredStateTestAgent(t)
		a.desiredStateSynced = true
		first := testDesiredPrinter("changed", 1, "active")
		row := desiredPrinterRecord{Desired: first, AppliedDesiredRevision: 1}
		oldConfig := desiredPrinterConfig(row)
		backend := &observedTransportPrinter{observed: true}
		a.printers[first.ID] = backend
		a.printerConfigs[first.ID] = oldConfig
		second := first
		second.DesiredRevision = 2
		second.Config = map[string]interface{}{"ip": "192.168.2.20", "port": 9100}
		row.Desired = second
		if replacementApplied {
			row.AppliedDesiredRevision = 2
			a.printerConfigs[first.ID] = desiredPrinterConfig(row)
			a.printers[first.ID] = &fakePrinter{}
		}
		a.desiredStates[first.ID] = row
		if a.recordPrinterProbeResult(first.ID, oldConfig, backend, "online") {
			t.Fatalf("old endpoint result accepted after applied=%v replacement", replacementApplied)
		}
		if a.desiredStates[first.ID].ObservedDesiredRevision != 0 || a.isPrinterExecutionAllowed(first.ID) {
			t.Fatal("old endpoint result enabled the replacement configuration")
		}
		if got := a.probeLastStatus(first.ID); got != "unknown" {
			t.Fatalf("old endpoint result poisoned status cache: %q", got)
		}
	}
}

func TestApplyingChangedConfigClearsEarlierHealthCache(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	first := desiredPrinterRecord{Desired: testDesiredPrinter("cache", 1, "active")}
	if err := a.applyDesiredPrinter(first); err != nil {
		t.Fatal(err)
	}
	a.setProbeLastStatus(first.Desired.ID, "offline")
	second := first
	second.Desired.DesiredRevision = 2
	second.Desired.Config = map[string]interface{}{"ip": "192.168.2.30", "port": 9100}
	if err := a.applyDesiredPrinter(second); err != nil {
		t.Fatal(err)
	}
	if got := a.probeLastStatus(first.Desired.ID); got != "unknown" {
		t.Fatalf("replacement retained earlier endpoint's %q health", got)
	}
}

func TestRediscoveryReplacementClearsEarlierHealthCache(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	row := desiredPrinterRecord{Desired: testDesiredPrinter("rediscovered", 1, "active")}
	first := desiredPrinterConfig(row)
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
