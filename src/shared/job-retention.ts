// Print-job payload/history retention policy.
// Terminal jobs keep their full payload for 48 hours, then Gateway archives a
// payload-free idempotency receipt and removes the bulky job/event history.
// Active queued/claimed/printing jobs are never removed by retention cleanup.
export const PRINT_JOB_RETENTION_HOURS = 48;
export const PRINT_JOB_RETENTION_MS = PRINT_JOB_RETENTION_HOURS * 60 * 60 * 1000;
