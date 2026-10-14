package agent

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestDesiredEndpointChangeCannotInheritLegacyBytePermissions(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	first := testDesiredPrinter("changed-capability", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{first})
	row := a.desiredStates[first.ID]
	row.ObservedSupportedProtocolsKnown = true
	row.ObservedSupportedProtocols = []string{"zpl"}
	a.desiredStates[first.ID] = row
	if err := a.applyDesiredPrinter(row); err != nil {
		t.Fatal(err)
	}
	second := first
	second.DesiredRevision = 2
	second.Config = map[string]interface{}{"ip": "192.168.2.20", "port": 9100}
	a.reconcileGatewayDesiredState([]desiredPrinterWire{second})
	if next := a.desiredStates[first.ID]; next.ObservedSupportedProtocolsKnown || len(next.ObservedSupportedProtocols) != 0 {
		t.Fatalf("new endpoint inherited old permissions: %#v", next)
	}
	facts, _ := a.deviceFacts(first.ID)
	if ok, _ := printer.PayloadCompatibleForDevice("raw", "zpl", facts); ok {
		t.Fatal("new raw endpoint accepted the prior endpoint's ZPL permission")
	}
}

func TestDesiredNameAndMediaUpdatesRetainSameBindingCapabilities(t *testing.T) {
	first := desiredPrinterRecord{Desired: testDesiredPrinter("same-binding", 1, "active"), ObservedSupportedProtocolsKnown: true, ObservedSupportedProtocols: []string{"escpos"}}
	second := first.Desired
	second.DesiredRevision = 2
	second.Name = "Friendly alias"
	second.Config = map[string]interface{}{"ip": "192.168.2.10", "port": 9100, "paper_width_mm": 80}
	row := desiredRecordForUpdate(first, second)
	if !row.ObservedSupportedProtocolsKnown || len(row.ObservedSupportedProtocols) != 1 || row.ObservedSupportedProtocols[0] != "escpos" {
		t.Fatalf("same-binding metadata change lost permissions: %#v", row)
	}
}

func TestChangedSpoolerBindingKeepsOnlyCurrentExplicitPassthrough(t *testing.T) {
	first := desiredPrinterRecord{Desired: testDesiredPrinter("spooler-policy", 1, "active"), ObservedSupportedProtocolsKnown: true, ObservedSupportedProtocols: []string{"raw"}}
	first.Desired.ConnectionType, first.Desired.Protocol = "spooler", "spooler"
	first.Desired.Config = map[string]interface{}{"spooler_name": "Old Queue", "address": "Old Queue"}
	second := first.Desired
	second.DesiredRevision = 2
	second.Config = map[string]interface{}{"spooler_name": "New Queue", "address": "New Queue", "passthrough_protocols": []interface{}{"escpos"}}
	row := desiredRecordForUpdate(first, second)
	pc := desiredPrinterConfig(row)
	facts := printerConfigFacts(pc)
	if row.ObservedSupportedProtocolsKnown {
		t.Fatal("old queue observation survived new binding")
	}
	if ok, _ := printer.PayloadCompatibleForDevice("escpos", "escpos", facts); !ok {
		t.Fatal("new queue explicit ESC/POS opt-in lost")
	}
	if ok, _ := printer.PayloadCompatibleForDevice("raw", "raw", facts); ok {
		t.Fatal("old RAW opt-in leaked into new queue")
	}
	if ok, _ := printer.PayloadCompatibleForDevice("pdf", "", facts); !ok {
		t.Fatal("document baseline lost")
	}
}

func TestChangedLegacySpoolerQueueCannotBorrowRawPassthrough(t *testing.T) {
	first := desiredPrinterRecord{Desired: testDesiredPrinter("legacy-spooler", 1, "active"), ObservedSupportedProtocolsKnown: true, ObservedSupportedProtocols: []string{"raw", "escpos"}}
	first.Desired.ConnectionType, first.Desired.Protocol = "spooler", "spooler"
	first.Desired.Config = map[string]interface{}{"spooler_name": "Receipt Queue", "address": "Receipt Queue"}
	if ok, _ := printer.PayloadCompatibleForDevice("raw", "raw", printerConfigFacts(desiredPrinterConfig(first))); !ok {
		t.Fatal("fixture lacks a real legacy RAW passthrough permission")
	}
	second := first.Desired
	second.DesiredRevision = 2
	second.Config = map[string]interface{}{"spooler_name": "Office Queue", "address": "Office Queue"}
	row := desiredRecordForUpdate(first, second)
	facts := printerConfigFacts(desiredPrinterConfig(row))
	if ok, _ := printer.PayloadCompatibleForDevice("raw", "raw", facts); ok {
		t.Fatal("new office queue inherited RAW bypass permission")
	}
	if ok, _ := printer.PayloadCompatibleForDevice("escpos", "escpos", facts); ok {
		t.Fatal("new office queue inherited ESC/POS bypass permission")
	}
	if ok, _ := printer.PayloadCompatibleForDevice("pdf", "", facts); !ok {
		t.Fatal("new office queue lost installed-driver document baseline")
	}
}

func TestPendingReplacementHeartbeatCannotRestoreOldCapabilityObservation(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	first := testDesiredPrinter("pending-capability", 1, "active")
	prior := desiredPrinterRecord{Desired: first, AppliedDesiredRevision: 1, ObservedSupportedProtocolsKnown: true, ObservedSupportedProtocols: []string{"zpl"}}
	pc := desiredPrinterConfig(prior)
	a.printers[first.ID] = &fakePrinter{status: "online"}
	a.printerConfigs[first.ID] = pc
	second := first
	second.DesiredRevision = 2
	second.Config = map[string]interface{}{"ip": "192.168.2.20", "port": 9100}
	a.desiredStates[first.ID] = desiredRecordForUpdate(prior, second)
	_ = a.printerStatusPayload()
	if row := a.desiredStates[first.ID]; row.ObservedSupportedProtocolsKnown || len(row.ObservedSupportedProtocols) != 0 {
		t.Fatalf("old heartbeat restored new-binding legacy permissions: %#v", row)
	}
}

func TestTransportBindingIncludesProtocolQueueAndUSBIdentity(t *testing.T) {
	base := config.PrinterConfig{Type: "usb", Protocol: "raw", Endpoint: `\\?\USB#TEST`, USBVID: "04b8", USBPID: "0202", USBSerial: "device-a"}
	for _, changed := range []config.PrinterConfig{
		{Type: "usb", Protocol: "escpos", Endpoint: base.Endpoint, USBVID: base.USBVID, USBPID: base.USBPID, USBSerial: base.USBSerial},
		{Type: "usb", Protocol: base.Protocol, Endpoint: base.Endpoint, USBVID: "1234", USBPID: base.USBPID, USBSerial: base.USBSerial},
		{Type: "usb", Protocol: base.Protocol, Endpoint: base.Endpoint, USBVID: base.USBVID, USBPID: "5678", USBSerial: base.USBSerial},
		{Type: "usb", Protocol: base.Protocol, Endpoint: base.Endpoint, USBVID: base.USBVID, USBPID: base.USBPID, USBSerial: "device-b"},
		{Type: "usb", Protocol: "spooler", Endpoint: base.Endpoint, SpoolerName: "New Queue", USBVID: base.USBVID, USBPID: base.USBPID, USBSerial: base.USBSerial},
	} {
		if samePrinterTransportBinding(base, changed) {
			t.Fatalf("different transport treated as same binding: %#v", changed)
		}
	}
}

func TestHeartbeatCapabilitiesUseCapturedTransportInsteadOfReplacement(t *testing.T) {
	const id = "capability-snapshot"
	backend := &heartbeatEvidencePrinter{}
	a := heartbeatEvidenceAgent(map[string]printer.Printer{id: backend})
	backend.statusRead = func() string {
		a.printersMu.Lock()
		pc := a.printerConfigs[id]
		pc.Endpoint, pc.Protocol = "10.0.0.30:9100", "tspl"
		pc.Capabilities = map[string]interface{}{"supported_protocols": []string{"tspl"}}
		a.printerConfigs[id] = pc
		a.printersMu.Unlock()
		return "online"
	}
	entry := heartbeatEntry(t, a.printerStatusPayload(), id)
	capabilities, ok := entry["capabilities"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing captured capability metadata: %#v", entry)
	}
	protocols, ok := capabilities["supported_protocols"].([]string)
	if entry["protocol"] != "raw" || !ok || len(protocols) != 1 || protocols[0] != "raw" {
		t.Fatalf("heartbeat mixed old config with replacement capabilities: %#v", entry)
	}
}
