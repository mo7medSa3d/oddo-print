package printer

// Preserve a primary Windows-reported reason beside the unchanged health
// enum. Values are the existing PRINTER_INFO_2 status/attribute masks.
func windowsStatusDetail(status, attributes uint32) string {
	if attributes&0x00000400 != 0 {
		return "windows_work_offline"
	}
	for _, reason := range [...]struct {
		bit  uint32
		code string
	}{
		{0x00000080, "windows_offline"},
		{0x02000000, "windows_server_offline"},
		{0x00001000, "windows_unavailable"},
		{0x00000004, "windows_pending_deletion"},
		{0x00000001, "windows_paused"},
		{0x00000008, "windows_paper_jam"},
		{0x00000010, "windows_paper_out"},
		{0x00400000, "windows_door_open"},
		{0x00000020, "windows_manual_feed"},
		{0x00000040, "windows_paper_problem"},
		{0x00000800, "windows_output_bin_full"},
		{0x00040000, "windows_no_toner"},
		{0x00100000, "windows_user_intervention"},
		{0x00200000, "windows_out_of_memory"},
		{0x00080000, "windows_page_punt"},
		{0x00000002, "windows_error"},
	} {
		if status&reason.bit != 0 {
			return reason.code
		}
	}
	switch mapWindowsStatus(status, attributes) {
	case "busy":
		if status&(0x00008000|0x00010000) != 0 {
			return "windows_initializing"
		}
		return "windows_busy"
	case "unknown":
		return "windows_status_unknown"
	}
	if status&0x00020000 != 0 {
		return "windows_toner_low"
	}
	if status&0x01000000 != 0 {
		return "windows_power_save"
	}
	if status&0x00002000 != 0 {
		return "windows_waiting"
	}
	return ""
}
