# Planned migrations (UNAPPLIED — require explicit approval)

Rollout ordering and mixed-version compatibility for these plans and for the
already-shipped behavior changes (D-1/D-2/D-6, T-2) are recorded in
`docs/RELEASE_GATES.md` ("Rollout compatibility"). Read both before applying.

These plans resolve the audit findings that need schema or semantic changes.
None of the SQL below has been created under `drizzle/` or executed. Each
plan is non-destructive: backfill first, constrain second, with a stated
rollback. Apply in journal order after approval; never squash or edit
migrations `0000`–`0081`.

Conventions: forward-only SQL, `CLOCK_TIMESTAMP()` for wall-clock writes,
`now()` for single-statement snapshots, advisory lock per table where a
backfill races writers (see `print_jobs:retention:v1` in
`cleanupTerminalPrintJobs`).

## 0082 — D-3: bound `tenant_subscriptions.current_period_end`

Problem: `active`/`trialing` rows with `current_period_end IS NULL` are
treated as live forever (deliberate compatibility, `API.md`).

Plan:
1. Backfill: for every `active`/`trialing` row with `current_period_end IS
   NULL`, set it from Stripe (`stripeRetrieve subscriptions/{id}` via an
   operator script, reusing the webhook's `stripeSubscriptionPeriod`
   parser). Rows with no retrievable Stripe subscription keep NULL and are
   listed for manual review — never invented.
2. Gate new writes: application code rejects `active`/`trialing` inserts
   without a period end (fail-closed; mirrors the existing
   `TenantEntitlementConfigError('subscription_period')` path used for
   `periodStart`).
3. Only after (1) reports zero NULLs and one full billing period passes,
   add `CHECK (status NOT IN ('active','trialing') OR current_period_end
   IS NOT NULL)`. Prefer CHECK over `SET NOT NULL` so `cancelled` history
   keeps its shape.
4. Flip `isSubscriptionPeriodLive()` and `liveTenantSubscriptionWhere` to
   treat NULL as expired for `active`/`trialing` (past_due keeps grace).

Rollback: drop the CHECK; no data deleted at any step. Verification:
`SELECT count(*) FROM tenant_subscriptions WHERE status IN
('active','trialing') AND current_period_end IS NULL;` must be 0, and
`billing-entitlement-access` plus the new acceptance test
`subscription-null-period-denied.integration.test.ts` (to be written on
approval) must pass.

## 0083 — E-4: bounded `print_job_receipts` retention

Problem: receipts grow forever; keys can never be reused.

Constraint (breaking — needs product decision): deleting a receipt allows
its idempotency key to mint a NEW operation. That changes idempotency
semantics, so the TTL itself is the approval item, not just the SQL.

Plan (default proposal: 90 days, tenant-configurable later):
1. Add `archived_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   (receipt creation time; existing rows backfill from the sibling
   `print_jobs.updated_at` where still present, else `clock_timestamp()` —
   both recorded in the migration output for audit).
2. Nightly delete in 500-row batches mirroring
   `cleanupTerminalPrintJobs` (advisory lock, `FOR UPDATE SKIP LOCKED`,
   metric `print_job_receipts_retention_deleted_total`).
3. A `409 IDEMPOTENCY_CONFLICT` against a missing receipt keeps its
   current meaning (unknown key); document that post-TTL reuse creates a
   new operation.

Rollback: stop the sweeper; deleted receipts are unrecoverable by design —
hence the 90-day window and the pre-delete `billing_events`-style audit
write per batch. Verification: row-age histogram query + acceptance test
`receipt-retention.integration.test.ts` (seed aged receipts, run sweep,
assert deletion + metric).

## 0084 — E-14: compact event summary on receipts

Problem: retention drops `job_events` (cascade), losing per-attempt history
for UNKNOWN forensics.

Plan (additive, non-breaking):
1. Add `attempt_summary jsonb NOT NULL DEFAULT '{}'` to
   `print_job_receipts`.
2. Both retention paths (`cleanupTerminalPrintJobs`, manual DELETE) fill it
   from `job_events` before delete: `{attempts, firstClaimedAt,
   lastUpdateAt, markers[], deliveries, acks}`. Bounded: 20 most recent
   events, 200 chars per message.
3. No backfill for already-archived receipts (their events are gone;
   record the cutoff date in OPERATIONS).

Rollback: drop the column. Verification: acceptance test
`receipt-event-summary.integration.test.ts` (seed events incl. an UNKNOWN
marker, run both retention paths, assert summary contents).

## 0085 — A-5: structured agent error codes

Problem: `PATCH /api/agent/jobs` error text is free-form; Odoo cannot
branch paper-out vs offline vs fatal.

Plan (additive):
1. Add `error_code text NULL` + `CHECK (error_code IN
   ('PAPER_OUT','COVER_OPEN','JAMMED','OFFLINE','TIMEOUT','SPOOLER_ERROR',
   'CANCELLED','UNKNOWN'))` to `print_jobs`; mirror onto receipts.
2. Agent sends `errorCode` alongside free text (Go: bounded enum, default
   omit). Gateway validates against the same set, stores verbatim text
   unchanged. Odoo syncs `errorCode` into `last_error` prefix
   (`[PAPER_OUT] ...`) without altering existing message parsing.
3. Unknown future codes are rejected 400 (closed vocabulary, like printer
   protocols), forcing explicit adoption.

Rollback: drop the columns; text path untouched throughout. Verification:
acceptance test `agent-error-code.integration.test.ts` (each code round-trips
Gateway→Odoo; unknown code 400s).

## 0086 — D-4: bounded `past_due` grace

Problem: `past_due` bypasses period expiry indefinitely until Stripe
transitions the subscription (weeks or never with filtered webhooks).

Constraint: the grace length is product policy. Proposal: 7 days past
`current_period_end`, then fail closed (same 403 operators already handle
for `unpaid`).

Plan (no backfill needed):
1. Add `past_due_since timestamptz NULL` to `tenant_subscriptions`, stamped
   by the webhook when a subscription first becomes `past_due`, cleared on
   any other status.
2. Liveness becomes `past_due AND (period_end IS NULL OR now <
   GREATEST(period_end, past_due_since + 7 days))`. `NULL` period keeps
   today's behavior until 0082 lands (order matters: land 0082 first).
3. `GET /api/billing/status` reports `graceEndsAt` so the UI can warn.

Rollback: drop the column; predicate falls back to status-only. Verification:
acceptance test `past-due-grace.integration.test.ts` (30-day-overdue
`past_due` denied; 1-day-overdue allowed with `graceEndsAt`).
