package printer

import "testing"

// The PRINTER_INFO_2 contract this task hinges on: a queue that is not
// despooling and reports no state bits is READY (Status == 0). These cases
// pin that a clean snapshot stays "online" through the job-correlation
// layer unless a live job proves activity or blockage.
func TestRefineStatusWithJobs(t *testing.T) {
	cases := []struct {
		name       string
		mapped     string
		detail     string
		jobs       []uint32
		wantStatus string
		wantDetail string
	}{
		// status == 0 (Ready) with an empty queue stays Ready.
		{"ready_empty_queue", "online", "", nil, "online", ""},
		// status == 0 with a job actively printing is Printing (busy).
		{"ready_printing_job", "online", "", []uint32{jobStatusPrinting}, "busy", "windows_busy"},
		{"ready_spooling_job", "online", "", []uint32{jobStatusSpooling}, "busy", "windows_busy"},
		// A paused job is not activity: the printer itself stays Ready.
		{"ready_paused_job", "online", "", []uint32{jobStatusPaused}, "online", ""},
		{"ready_paused_printing_job", "online", "", []uint32{jobStatusPaused | jobStatusPrinting}, "online", ""},
		// A live job in an error state surfaces as a printer error with the
		// exact job reason, even when the printer bits look clean.
		{"ready_error_job", "online", "", []uint32{jobStatusError}, "error", "windows_job_error"},
		{"busy_error_job", "busy", "windows_busy", []uint32{jobStatusError}, "error", "windows_job_error"},
		{"ready_blocked_job", "online", "", []uint32{jobStatusBlockedDevQ}, "error", "windows_job_error"},
		{"ready_intervention_job", "online", "", []uint32{jobStatusUserIntervention}, "error", "windows_job_error"},
		// Terminal jobs are history: a retained printed job changes nothing.
		{"ready_printed_retained_job", "online", "", []uint32{jobStatusPrinted | jobStatusRetained}, "online", ""},
		{"ready_complete_job", "online", "", []uint32{jobStatusComplete}, "online", ""},
		{"ready_error_but_printed_job", "online", "", []uint32{jobStatusError | jobStatusPrinted}, "online", ""},
		// Job evidence never downgrades the printer's own stronger state.
		{"offline_printing_job", "offline", "windows_offline", []uint32{jobStatusPrinting}, "offline", "windows_offline"},
		{"error_printing_job", "error", "windows_paper_jam", []uint32{jobStatusPrinting}, "error", "windows_paper_jam"},
		{"unknown_error_job", "unknown", "windows_status_unknown", []uint32{jobStatusError}, "unknown", "windows_status_unknown"},
		// An existing benign detail (toner low) survives a busy refinement.
		{"toner_low_printing_job", "online", "windows_toner_low", []uint32{jobStatusPrinting}, "busy", "windows_toner_low"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotStatus, gotDetail := refineStatusWithJobs(tc.mapped, tc.detail, summarizeJobStatuses(tc.jobs))
			if gotStatus != tc.wantStatus || gotDetail != tc.wantDetail {
				t.Errorf("refineStatusWithJobs(%q, %q, %v) = (%q, %q), want (%q, %q)",
					tc.mapped, tc.detail, tc.jobs, gotStatus, gotDetail, tc.wantStatus, tc.wantDetail)
			}
		})
	}
}

// Status 0 is the single most important snapshot in the whole mapping:
// it is what every healthy idle printer reports. Pin it directly, beside
// the benign-bit combinations Windows may add to a ready queue.
func TestMapWindowsStatusZeroIsReady(t *testing.T) {
	if got := mapWindowsStatus(0, 0); got != "online" {
		t.Fatalf("mapWindowsStatus(0, 0) = %q, want online (PRINTER_STATUS 0 means Ready)", got)
	}
	if got := windowsStatusDetail(0, 0); got != "" {
		t.Fatalf("windowsStatusDetail(0, 0) = %q, want empty detail for a clean ready queue", got)
	}
	for _, benign := range []uint32{0x00002000, 0x00020000, 0x01000000, 0x00002000 | 0x00020000 | 0x01000000} {
		if got := mapWindowsStatus(benign, 0); got != "online" {
			t.Errorf("mapWindowsStatus(0x%08x, 0) = %q, want online", benign, got)
		}
	}
}
