package agent

import (
	"fmt"
	"sync"
	"testing"

	"github.com/yaseir-agent/agent/internal/printer"
)

func heartbeatReasonCaps(t *testing.T, payload []map[string]interface{}, id string) map[string]interface{} {
	t.Helper()
	entry := heartbeatEntry(t, payload, id)
	caps, ok := entry["capabilities"].(map[string]interface{})
	if !ok {
		t.Fatalf("entry %s has no capabilities map: %#v", id, entry)
	}
	return caps
}

// WP2: a still-running probe still publishes its row, as unknown with a
// still-running reason — never a silent drop, never a bare unknown.
func TestHeartbeatStillRunningProbeKeepsReasonAndRow(t *testing.T) {
	p := &heartbeatEvidencePrinter{statusRead: func() string { panic("a running probe must not be reentered") },
		detailRead: func() string { panic("an uncompleted read cannot publish a detail") }}
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": p})
	state := a.getProbeState("p")
	state.running.Store(true)
	defer state.running.Store(false)
	payload := a.printerStatusPayload()
	entry := heartbeatEntry(t, payload, "p")
	if entry["status"] != "unknown" {
		t.Fatalf("status=%v want unknown", entry["status"])
	}
	caps := heartbeatReasonCaps(t, payload, "p")
	if caps["status_reason"] != "probe_still_running" {
		t.Fatalf("status_reason=%v want probe_still_running", caps["status_reason"])
	}
	if _, exists := caps["status_detail"]; exists {
		t.Fatalf("uncompleted probe published a detail: %#v", caps)
	}
	if p.statusCalls.Load() != 0 || p.detailCalls.Load() != 0 {
		t.Fatal("still-running projection re-entered the probe")
	}
}

// WP2: a completed unknown with no backend detail gets a heartbeat-owned
// reason, and a backend failure detail becomes both status_detail and
// status_reason, so the Gateway can tell failure kinds apart.
func TestHeartbeatUnknownReasonsDistinguishBackendFailures(t *testing.T) {
	plain := &heartbeatEvidencePrinter{statusRead: func() string { return "unknown" }, detailRead: func() string { return "" }}
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": plain})
	caps := heartbeatReasonCaps(t, a.printerStatusPayload(), "p")
	if caps["status_reason"] != "probe_completed_unknown" {
		t.Fatalf("status_reason=%v want probe_completed_unknown", caps["status_reason"])
	}
	if _, exists := caps["status_detail"]; exists {
		t.Fatalf("detail-less probe published a detail: %#v", caps)
	}

	failed := &heartbeatEvidencePrinter{statusRead: func() string { return "unknown" }, detailRead: func() string { return "spooler_open_failed_win32_5" }}
	a = heartbeatEvidenceAgent(map[string]printer.Printer{"p": failed})
	caps = heartbeatReasonCaps(t, a.printerStatusPayload(), "p")
	if caps["status_detail"] != "spooler_open_failed_win32_5" || caps["status_reason"] != "spooler_open_failed_win32_5" {
		t.Fatalf("failure detail/reason = %v / %v, want spooler_open_failed_win32_5 for both", caps["status_detail"], caps["status_reason"])
	}

	// A spooler raw hex travels beside the mapped status when the backend
	// supplies one.
	raw := &rawHexPrinter{heartbeatEvidencePrinter: &heartbeatEvidencePrinter{
		statusRead: func() string { return "offline" }, detailRead: func() string { return "windows_offline" }}}
	a = heartbeatEvidenceAgent(map[string]printer.Printer{"p": raw})
	caps = heartbeatReasonCaps(t, a.printerStatusPayload(), "p")
	if caps["spooler_status_raw"] != "0x00000080" {
		t.Fatalf("spooler_status_raw=%v want 0x00000080", caps["spooler_status_raw"])
	}
	if caps["status_detail"] != "windows_offline" || caps["status_reason"] != "windows_offline" {
		t.Fatalf("offline detail/reason = %v / %v, want windows_offline for both", caps["status_detail"], caps["status_reason"])
	}
}

// rawHexPrinter is a spooler-like backend that also reports the raw
// PRINTER_INFO_2 Status hex behind its mapped status.
type rawHexPrinter struct {
	*heartbeatEvidencePrinter
}

func (p *rawHexPrinter) StatusRawHex() string { return "0x00000080" }

// WP2: a panicking probe publishes unknown with a panic reason, and does
// not read (or advance) any backend detail.
func TestHeartbeatProbePanicKeepsPanicReason(t *testing.T) {
	p := &heartbeatEvidencePrinter{statusRead: func() string { panic("failed status adapter") },
		detailRead: func() string { panic("an uncompleted read cannot publish a detail") }}
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": p})
	a.setProbeLastStatus("p", "offline")
	payload := a.printerStatusPayload()
	entry := heartbeatEntry(t, payload, "p")
	if entry["status"] != "unknown" {
		t.Fatalf("status=%v want unknown", entry["status"])
	}
	caps := heartbeatReasonCaps(t, payload, "p")
	if caps["status_reason"] != "probe_panic" {
		t.Fatalf("status_reason=%v want probe_panic", caps["status_reason"])
	}
	if _, exists := caps["status_detail"]; exists {
		t.Fatalf("panicking probe published a detail: %#v", caps)
	}
	if p.detailCalls.Load() != 0 {
		t.Fatal("panic path read a backend detail")
	}
}

// WP2: the 10s batch budget still defers slow probes, but every deferred
// row carries the budget reason instead of a bare unknown, and no row is
// dropped from the payload. (This exercises the real 10s bound, like the
// existing budget test.)
func TestHeartbeatBudgetDeferredProbeKeepsBudgetReason(t *testing.T) {
	const count = maxHeartbeatProbeConcurrency + 1
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	backends := make(map[string]printer.Printer, count)
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("budget-%03d", i)
		backends[id] = &heartbeatEvidencePrinter{statusRead: func() string { <-release; return "online" },
			detailRead: func() string { return "windows_power_save" }}
	}
	a := heartbeatEvidenceAgent(backends)
	deferred := a.printerStatusPayload()
	if len(deferred) != count {
		unblock()
		t.Fatalf("bounded frame lost inventory: %d", len(deferred))
	}
	for id := range backends {
		entry := heartbeatEntry(t, deferred, id)
		if entry["status"] != "unknown" {
			unblock()
			t.Fatalf("deferred %s status=%v want unknown", id, entry["status"])
		}
		caps := heartbeatReasonCaps(t, deferred, id)
		if caps["status_reason"] != "probe_batch_budget_exceeded" {
			unblock()
			t.Fatalf("deferred %s status_reason=%v want probe_batch_budget_exceeded", id, caps["status_reason"])
		}
		if _, exists := caps["status_detail"]; exists {
			unblock()
			t.Fatalf("deferred %s published an unfinished detail: %#v", id, caps)
		}
	}
}
