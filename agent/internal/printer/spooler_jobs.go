package printer

// JOB_STATUS_* bits from winspool.h, as returned in JOB_INFO_2.Status.
// Kept platform-neutral (hex literals, like the mapping tests) so the
// job-correlation rules run — and are unit-tested — on every platform;
// only the EnumJobsW reader itself is Windows-only.
const (
	jobStatusPaused           = 0x0001 // JOB_STATUS_PAUSED
	jobStatusError            = 0x0002 // JOB_STATUS_ERROR
	jobStatusDeleting         = 0x0004 // JOB_STATUS_DELETING
	jobStatusSpooling         = 0x0008 // JOB_STATUS_SPOOLING
	jobStatusPrinting         = 0x0010 // JOB_STATUS_PRINTING
	jobStatusOffline          = 0x0020 // JOB_STATUS_OFFLINE
	jobStatusPaperOut         = 0x0040 // JOB_STATUS_PAPEROUT
	jobStatusPrinted          = 0x0080 // JOB_STATUS_PRINTED
	jobStatusDeleted          = 0x0100 // JOB_STATUS_DELETED
	jobStatusBlockedDevQ      = 0x0200 // JOB_STATUS_BLOCKED_DEVQ
	jobStatusUserIntervention = 0x0400 // JOB_STATUS_USER_INTERVENTION
	jobStatusRestart          = 0x0800 // JOB_STATUS_RESTART
	jobStatusComplete         = 0x1000 // JOB_STATUS_COMPLETE
	jobStatusRetained         = 0x2000 // JOB_STATUS_RETAINED
)

// queueJobActivity summarises one queue's job list (EnumJobs) into the two
// facts that can refine a printer status read: a job is actively moving
// (spooling/printing), or a job is blocked in an error state. A job that
// already reached a terminal state (printed/complete/deleted) is history,
// not activity: a retained completed job must not pin its queue to "busy"
// or "error" forever.
type queueJobActivity struct {
	any     bool
	active  bool
	blocked bool
}

func summarizeJobStatuses(statuses []uint32) queueJobActivity {
	var act queueJobActivity
	for _, st := range statuses {
		act.any = true
		finished := st&(jobStatusPrinted|jobStatusComplete|jobStatusDeleted|jobStatusDeleting) != 0
		if finished {
			continue
		}
		if st&jobStatusPaused == 0 && st&(jobStatusPrinting|jobStatusSpooling) != 0 {
			act.active = true
		}
		if st&(jobStatusError|jobStatusBlockedDevQ|jobStatusUserIntervention) != 0 {
			act.blocked = true
		}
	}
	return act
}

// refineStatusWithJobs correlates the PRINTER_INFO_2-mapped status with
// the queue's live jobs, the way Windows' own queue window does: a queue
// whose driver reports no activity bits but which is actively printing a
// job is "busy", and a queue with a job stuck in an error state is in
// "error" even when the printer bits alone look clean. Job evidence never
// downgrades a stronger printer state (offline/error from the printer's
// own bits always wins) and never invents a state for an unreadable or
// empty queue.
func refineStatusWithJobs(mapped, detail string, act queueJobActivity) (string, string) {
	if !act.any {
		return mapped, detail
	}
	if act.blocked && (mapped == "online" || mapped == "busy") {
		return "error", "windows_job_error"
	}
	if act.active && mapped == "online" {
		if detail == "" {
			detail = "windows_busy"
		}
		return "busy", detail
	}
	return mapped, detail
}
