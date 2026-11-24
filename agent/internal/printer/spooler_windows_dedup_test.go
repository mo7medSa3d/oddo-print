//go:build windows

package printer

import (
	"fmt"
	"syscall"
	"testing"
)

// WP1: enumeration dedup is by full queue identity (name + server +
// scope), never by display name alone. Distinct queues that share a name
// must both survive; only an exact repeat collapses.
func TestEnumDedupKeepsDistinctQueuesAndCollapsesExactRepeats(t *testing.T) {
	cases := []struct {
		name  string
		in    []printerQueueRef
		want  int
		names []string // expected (name, server, scope) triples in order, as "name|server|scope"
	}{
		{
			name: "same queue twice collapses to one",
			in: []printerQueueRef{
				{name: "POS80 Printer", server: "", scope: "machine_local"},
				{name: "POS80 Printer", server: "", scope: "machine_local"},
			},
			want:  1,
			names: []string{"POS80 Printer||machine_local"},
		},
		{
			name: "same name different server stays distinct",
			in: []printerQueueRef{
				{name: "Receipt", server: "", scope: "machine_local"},
				{name: "Receipt", server: `\\print-server`, scope: "machine_local"},
			},
			want:  2,
			names: []string{"Receipt||machine_local", `Receipt|\\print-server|machine_local`},
		},
		{
			name: "same name same server different scope stays distinct",
			in: []printerQueueRef{
				{name: "Receipt", server: "", scope: "machine_local"},
				{name: "Receipt", server: "", scope: "user_connection"},
			},
			want:  2,
			names: []string{"Receipt||machine_local", "Receipt||user_connection"},
		},
		{
			name: "case and whitespace variants of one queue collapse",
			in: []printerQueueRef{
				{name: "POS80 Printer", server: "", scope: "machine_local"},
				{name: "  pos80 printer ", server: "", scope: "machine_local"},
			},
			want:  1,
			names: []string{"POS80 Printer||machine_local"},
		},
		{
			name: "empty names are skipped, order is first-seen",
			in: []printerQueueRef{
				{name: "  ", server: "", scope: "machine_local"},
				{name: "B", server: "", scope: "machine_local"},
				{name: "A", server: "", scope: "machine_local"},
				{name: "B", server: "", scope: "machine_local"},
			},
			want:  2,
			names: []string{"B||machine_local", "A||machine_local"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dedupPrinterQueues(tc.in)
			if len(got) != tc.want {
				t.Fatalf("dedup gave %d rows, want %d: %#v", len(got), tc.want, got)
			}
			for i, want := range tc.names {
				if have := got[i].name + "|" + got[i].server + "|" + got[i].scope; have != want {
					t.Fatalf("row %d = %q, want %q", i, have, want)
				}
			}
		})
	}
}

// WP2: a successful observation carries the raw Status hex beside the
// mapped status, and a failed observation carries the exact Win32 code.
func TestObserveSpoolerStatusSurfacesRawHexAndExactWin32Code(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_PAPER_OUT|PRINTER_STATUS_PRINTING, 0)
	p := NewSpooler("Raw Status Queue", "")
	if st := p.Status(); st != "error" {
		t.Fatalf("status=%q want error", st)
	}
	if p.StatusDetail() != "windows_paper_out" {
		t.Fatalf("detail=%q want windows_paper_out", p.StatusDetail())
	}
	if p.StatusRawHex() != "0x00000410" {
		t.Fatalf("raw=%q want 0x00000410", p.StatusRawHex())
	}
	if formatSpoolerStatusHex(0) != "0x00000000" || formatSpoolerStatusHex(0x00800000) != "0x00800000" {
		t.Fatal("raw hex formatting changed")
	}

	// OpenPrinter failure: reason keeps the Win32 code, status stays unknown.
	restore := setPrinterHooks(func(*uint16) (syscall.Handle, error) { return 0, syscall.Errno(5) }, fakePrinterInfo2(0, 0))
	obs := observeSpoolerStatus("User-only Queue")
	restore()
	if obs.err == nil || obs.rawValid || obs.status != "unknown" {
		t.Fatalf("open failure observation invented evidence: %#v", obs)
	}
	if got := spoolerProbeFailureDetail(obs.err); got != "spooler_open_failed_win32_5" {
		t.Fatalf("open failure detail=%q want spooler_open_failed_win32_5", got)
	}

	// GetPrinter failure: a different code stays a different reason.
	restore = setPrinterHooks(func(*uint16) (syscall.Handle, error) { return 4711, nil },
		func(syscall.Handle) (*printerInfo2, []byte, error) { return nil, nil, syscall.Errno(6) })
	obs = observeSpoolerStatus("Broken Detail Queue")
	restore()
	if obs.err == nil || obs.rawValid {
		t.Fatalf("get failure observation invented evidence: %#v", obs)
	}
	if got := spoolerProbeFailureDetail(obs.err); got != "spooler_get_failed_win32_6" {
		t.Fatalf("get failure detail=%q want spooler_get_failed_win32_6", got)
	}

	// Timeout / unresponsive collapses to neither offline nor a Win32 code.
	if got := spoolerProbeFailureDetail(fmt.Errorf("%w: wedged", ErrSpoolerUnresponsive)); got != "spooler_probe_timeout" {
		t.Fatalf("timeout detail=%q want spooler_probe_timeout", got)
	}
}

// WP1: provenance stamps distinguish a Session-0 service row from an
// interactive-session row, per row, without changing identity or status.
func TestDiscoveryProvenanceStampsSessionAndAccount(t *testing.T) {
	infos := []DeviceInfo{
		{Name: "A", Capabilities: nil},
		{Name: "B", Capabilities: map[string]interface{}{"spooler_scope": "machine_local"}},
	}
	annotateDiscoveryProvenance(infos, discoveryProvenance{sessionID: 0, sessionKnown: true, accountSID: "S-1-5-18", accountKnown: true})
	if infos[0].Capabilities["discovery_session_kind"] != "service_session_0" ||
		infos[0].Capabilities["discovery_account_is_service"] != true ||
		infos[1].Capabilities["spooler_scope"] != "machine_local" {
		t.Fatalf("service provenance lost or clobbered caps: %#v", infos)
	}
	annotateDiscoveryProvenance(infos, discoveryProvenance{sessionID: 3, sessionKnown: true, accountSID: "S-1-5-21-1", accountKnown: true})
	if infos[0].Capabilities["discovery_session_id"] != uint32(3) ||
		infos[0].Capabilities["discovery_session_kind"] != "interactive_session" ||
		infos[0].Capabilities["discovery_account_is_service"] != false {
		t.Fatalf("interactive provenance wrong: %#v", infos[0].Capabilities)
	}
	unknown := []DeviceInfo{{Name: "C", Capabilities: map[string]interface{}{}}}
	annotateDiscoveryProvenance(unknown, discoveryProvenance{})
	if _, ok := unknown[0].Capabilities["discovery_session_id"]; ok {
		t.Fatal("unknown provenance invented a session")
	}
}
