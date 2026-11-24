package printer

import (
	"reflect"
	"testing"
)

// WP2: every PRINTER_STATUS_* bit maps to exactly one Gateway status, with
// the proven precedence (offline > error > busy > SERVER_UNKNOWN), and
// every bit has a distinct detail code. Constants are written as hex
// literals here because the PRINTER_STATUS_* constants themselves live in
// the Windows-only spooler file; this test must run on Linux CI too.
func TestMapWindowsStatusCoversEveryStatusBit(t *testing.T) {
	cases := []struct {
		status     uint32
		attributes uint32
		want       string
		detail     string
	}{
		{0x00000001, 0, "error", "windows_paused"},
		{0x00000002, 0, "error", "windows_error"},
		{0x00000004, 0, "error", "windows_pending_deletion"},
		{0x00000008, 0, "error", "windows_paper_jam"},
		{0x00000010, 0, "error", "windows_paper_out"},
		{0x00000020, 0, "error", "windows_manual_feed"},
		{0x00000040, 0, "error", "windows_paper_problem"},
		{0x00000080, 0, "offline", "windows_offline"},
		{0x00000100, 0, "busy", "windows_busy"},
		{0x00000200, 0, "busy", "windows_busy"},
		{0x00000400, 0, "busy", "windows_busy"},
		{0x00000800, 0, "error", "windows_output_bin_full"},
		{0x00001000, 0, "offline", "windows_unavailable"},
		{0x00002000, 0, "online", "windows_waiting"},
		{0x00004000, 0, "busy", "windows_busy"},
		{0x00008000, 0, "busy", "windows_initializing"},
		{0x00010000, 0, "busy", "windows_initializing"},
		{0x00020000, 0, "online", "windows_toner_low"},
		{0x00040000, 0, "error", "windows_no_toner"},
		{0x00080000, 0, "error", "windows_page_punt"},
		{0x00100000, 0, "error", "windows_user_intervention"},
		{0x00200000, 0, "error", "windows_out_of_memory"},
		{0x00400000, 0, "error", "windows_door_open"},
		{0x00800000, 0, "unknown", "windows_status_unknown"},
		{0x01000000, 0, "online", "windows_power_save"},
		{0x02000000, 0, "offline", "windows_server_offline"},
		{0, 0x00000400, "offline", "windows_work_offline"},
		{0, 0, "online", ""},
		// Combined bits: precedence, never a new status word.
		{0x00000080 | 0x00000002, 0, "offline", "windows_offline"},
		{0x00000002 | 0x00000200, 0, "error", "windows_error"},
		{0x00000200 | 0x00800000, 0, "busy", "windows_busy"},
		{0x00800000 | 0x00000010, 0, "error", "windows_paper_out"},
		{0x00800000 | 0x00000080, 0, "offline", "windows_offline"},
		{0x00002000 | 0x00020000 | 0x01000000, 0, "online", "windows_toner_low"},
		// A reserved/unmodelled bit alone fails closed to unknown, never
		// to a fabricated ready/connected state.
		{0x80000000, 0, "unknown", "windows_status_unknown"},
		// "Ready/connected" (online) only for a clean snapshot: no
		// offline/paused/error bit set, and no reserved bit set.
		{0x00000400 | 0x00002000, 0, "busy", "windows_busy"},
	}
	for _, tc := range cases {
		if got := mapWindowsStatus(tc.status, tc.attributes); got != tc.want {
			t.Errorf("mapWindowsStatus(0x%08x, 0x%08x) = %q, want %q", tc.status, tc.attributes, got, tc.want)
		}
		if got := windowsStatusDetail(tc.status, tc.attributes); got != tc.detail {
			t.Errorf("windowsStatusDetail(0x%08x, 0x%08x) = %q, want %q", tc.status, tc.attributes, got, tc.detail)
		}
	}
}

func TestWindowsStatusBitNamesListSetBitsInOrder(t *testing.T) {
	got := WindowsStatusBitNames(0x00000410, 0x00000400)
	want := []string{"PRINTER_ATTRIBUTE_WORK_OFFLINE", "PRINTER_STATUS_PAPER_OUT", "PRINTER_STATUS_PRINTING"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bit names = %v, want %v", got, want)
	}
	if got := WindowsStatusBitNames(0, 0); len(got) != 0 {
		t.Fatalf("clean snapshot listed bits: %v", got)
	}
	if got := WindowsStatusBitNames(0x00800000, 0); len(got) != 1 || got[0] != "PRINTER_STATUS_SERVER_UNKNOWN" {
		t.Fatalf("server-unknown bit names = %v", got)
	}
}
