package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/printer"
)

// WP1/WP2: diagnose output contract — one row per discovered queue with
// driver/port/status/error plus the 1:1 comparison fields (server, scope,
// raw Status hex, detail, per-queue error, Session-0 provenance), so a
// diagnose row can be checked against Windows Settings > Printers and
// Get-Printer output without re-probing.
func TestDiagnoseQueueInfoContract(t *testing.T) {
	device := printer.DeviceInfo{
		Name: "POS80 Printer", ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: "POS80 Printer", SpoolerServer: `\\print-server`, SpoolerPort: "USB001",
		SpoolerDriver: "POS80 Driver", Status: "error",
		Capabilities: map[string]interface{}{
			"driver_name": "POS80 Driver", "port_name": "USB001",
			"spooler_scope": "machine_local", "spooler_status_raw": "0x00000010",
			"spooler_status_detail": "windows_paper_out",
			"discovery_session_id":  uint32(0), "discovery_session_kind": "service_session_0",
			"discovery_account_sid": "S-1-5-18",
		},
	}
	q := queueInfoFromDevice(device, nil)
	if q.Driver != "POS80 Driver" || q.Port != "USB001" || q.Status != "error" {
		t.Fatalf("basic queue fields lost: %#v", q)
	}
	if q.Server != `\\print-server` || q.Scope != "machine_local" {
		t.Fatalf("server/scope lost: %#v", q)
	}
	if q.StatusRaw != "0x00000010" || q.StatusDetail != "windows_paper_out" {
		t.Fatalf("raw/detail lost: %#v", q)
	}
	if q.DiscoverySessionKind != "service_session_0" || q.DiscoveryAccountSID != "S-1-5-18" {
		t.Fatalf("provenance lost: %#v", q)
	}
	encoded, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"server"`, `"scope"`, `"status_raw"`, `"status_detail"`, `"discovery_session_kind"`, `"discovery_account_sid"`} {
		if !strings.Contains(string(encoded), key) {
			t.Fatalf("JSON contract missing %s: %s", key, encoded)
		}
	}

	// A per-queue probe error stays attached to its queue, and a
	// successful probe refreshes the raw hex from current evidence.
	unreadable := device
	unreadable.Capabilities = map[string]interface{}{"spooler_status_error": "spooler_open_failed_win32_5"}
	q = queueInfoFromDevice(unreadable, &printer.SpoolerProbe{QueueName: "POS80 Printer", Verdict: printer.SpoolerStatusUnknown, OpenPrinterError: "Access is denied."})
	if q.StatusError != "spooler_open_failed_win32_5" || q.SpoolerOpenError != "Access is denied." {
		t.Fatalf("probe error not attached to its queue: %#v", q)
	}
	if q.StatusRaw != "" {
		t.Fatalf("failed probe overwrote the discovery raw hex with a zero flag word: %q", q.StatusRaw)
	}
	q = queueInfoFromDevice(device, &printer.SpoolerProbe{QueueName: "POS80 Printer", DriverName: "POS80 Driver", PortName: "USB001",
		Verdict: printer.SpoolerReadyToAccept, OpenPrinterOK: true, GetPrinterOK: true, StatusFlags: 0x00000080})
	if q.StatusRaw != "0x00000080" {
		t.Fatalf("successful probe did not refresh raw hex: %q", q.StatusRaw)
	}
}

func TestDiagnoseQueueSortKeepsSameNameQueuesDistinct(t *testing.T) {
	queues := []QueueInfo{
		{Name: "Receipt", Server: `\\b-server`, Scope: "machine_local"},
		{Name: "Receipt", Server: "", Scope: "user_connection"},
		{Name: "Receipt", Server: "", Scope: "machine_local"},
		{Name: "Alpha", Server: "", Scope: "machine_local"},
	}
	sortDiagnosticQueues(queues)
	want := []QueueInfo{
		{Name: "Alpha", Server: "", Scope: "machine_local"},
		{Name: "Receipt", Server: "", Scope: "machine_local"},
		{Name: "Receipt", Server: "", Scope: "user_connection"},
		{Name: "Receipt", Server: `\\b-server`, Scope: "machine_local"},
	}
	for i, w := range want {
		if queues[i].Name != w.Name || queues[i].Server != w.Server || queues[i].Scope != w.Scope {
			t.Fatalf("row %d = %+v, want %+v (full order: %+v)", i, queues[i], w, queues)
		}
	}
}
