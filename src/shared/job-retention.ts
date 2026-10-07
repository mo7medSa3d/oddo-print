// Print-job payload/history retention policy.
// Terminal jobs keep their full payload for 48 hours, then Gateway archives a
// payload-free idempotency receipt and removes the bulky job/event history.
// Active queued/claimed/printing jobs are never removed by retention cleanup.
export const PRINT_JOB_RETENTION_HOURS = 48;
export const PRINT_JOB_RETENTION_MS = PRINT_JOB_RETENTION_HOURS * 60 * 60 * 1000;
// Full print-job rows (payloads up to 5 MiB) must never be materialized in
// the hundreds/thousands at once: retention, agent-deletion archive and
// manual cleanup all bound in-memory document bytes independently of their
// row-count limits by processing at most this many full rows per inner
// batch. Worst-case peak stays near 20 x 5 MiB regardless of the outer limit.
export const RECEIPT_MATERIALIZE_BATCH_ROWS = 20;
