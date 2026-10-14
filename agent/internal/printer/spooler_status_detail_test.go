package printer

import "testing"

func TestWindowsStatusDetailPreservesActionableNativeReasons(t *testing.T) {
	for _, test := range []struct {
		status     uint32
		attributes uint32
		code       string
	}{
		{0, 0x00000400, "windows_work_offline"},
		{0x00000080, 0, "windows_offline"},
		{0x02000000, 0, "windows_server_offline"},
		{0x00001000, 0, "windows_unavailable"},
		{0x00000004, 0, "windows_pending_deletion"},
		{0x00000001, 0, "windows_paused"},
		{0x00000008, 0, "windows_paper_jam"},
		{0x00000010, 0, "windows_paper_out"},
		{0x00400000, 0, "windows_door_open"},
		{0x00000020, 0, "windows_manual_feed"},
		{0x00000040, 0, "windows_paper_problem"},
		{0x00000800, 0, "windows_output_bin_full"},
		{0x00040000, 0, "windows_no_toner"},
		{0x00100000, 0, "windows_user_intervention"},
		{0x00200000, 0, "windows_out_of_memory"},
		{0x00080000, 0, "windows_page_punt"},
		{0x00000002, 0, "windows_error"},
		{0x00000400, 0, "windows_busy"},
		{0x00008000, 0, "windows_initializing"},
		{0x00800000, 0, "windows_status_unknown"},
		{0x80000000, 0, "windows_status_unknown"},
		{0x00020000, 0, "windows_toner_low"},
		{0x01000000, 0, "windows_power_save"},
		{0x00002000, 0, "windows_waiting"},
		{0, 0, ""},
		// Blocking/administrative flags outrank concurrent activity and
		// inconclusive server flags, matching the existing health mapper.
		{0x00800410, 0, "windows_paper_out"},
		{0x00800401, 0, "windows_paused"},
		{0x00800400, 0, "windows_busy"},
	} {
		if got := windowsStatusDetail(test.status, test.attributes); got != test.code {
			t.Fatalf("status=0x%08x attributes=0x%08x: detail=%q want %q", test.status, test.attributes, got, test.code)
		}
	}
}
