# Correctness Review — Time, Billing, Quota, WebSocket and Agent

Scope: a full pass over the sensitive areas of the platform — billing/payment,
the WebSocket delivery path and its fallback, time discipline between the
Gateway, PostgreSQL, Odoo and the Windows Agent, the plan/quota implementation,
and the quota-exhausted dialog. Findings are separated into defects that were
fixed, behaviour that was verified as correct, and recommendations that need a
product decision rather than a patch.

## 1. Defects fixed

### 1.1 Time authority was not unified (highest impact)

Durable timestamps were written on one clock and compared on another. Every case
below could produce a wrong *decision*, not just a wrong display value.

| Symptom | Cause | Fix |
| --- | --- | --- |
| A live Agent could be reported offline until the next heartbeat (host clock behind PostgreSQL left `last_seen_at` in the future, which the availability gate treats as stale) | `agents.last_seen_at` / `printers.last_seen_at` written with the Node host clock while the claim gates compare `last_seen_at > now() - interval` | Presence writes use `now()` (`src/app/api/agent/heartbeat/route.ts`) |
| A dead Agent could stay "online" indefinitely (host clock ahead) | JS availability helpers defaulted to `new Date()` | `getAgentAvailability`, `isAgentAvailableForJob`, `getEffectivePrinterStatus`, agent/printer health and routing defaults use the calibrated clock (`src/lib/agent-availability.ts`, `agent-health.ts`, `printer-health.ts`, `routing.ts`) |
| Every Stripe webhook could be rejected as a replay (billing state silently stops syncing) | Signature tolerance compared Stripe's event timestamp with the host clock | `verifyStripeSignature` uses the calibrated clock (`src/lib/stripe.ts`) |
| A payable Checkout Session could be treated as expired — handing the customer a dead URL or opening a second, payable session | Session expiry compared with the host clock | `checkoutIntentExpired` uses the calibrated clock (`src/app/api/billing/checkout/route.ts`) |
| A paying tenant could be locked out of pairing/printing (403 `SUBSCRIPTION_REQUIRED`) or an expired subscription could stay provisioned | Four duplicated period gates compared `current_period_end` with the host clock | One helper on the calibrated clock: `isBillingAccessStatus`, `isSubscriptionPeriodLive` (`src/lib/entitlements.ts`) used by billing status and the three Odoo routes |
| A job's stored TTL could differ from the requested TTL, and the per-minute rate window could undercount | `expires_at` derived from `clock_timestamp()` while `created_at` fell back to the `now()` column default (transaction start) | The enqueue stamps `created_at`/`updated_at` from the same clock read; migration `0067_print_job_wall_clock.sql` moves both `print_jobs` defaults to `clock_timestamp()` |

The calibration itself lives in `src/lib/database-clock.ts`: `refreshClockSkew()`
measures `clock_timestamp() - host_midpoint` at most once per 30 s (2 s timeout,
failed attempts throttled the same way), `gatewayNowMs()` / `gatewayNow()` expose
the result, and an uncalibrated process simply behaves as before. A database
outage therefore degrades accuracy, never availability. The policy is documented
in `ARCHITECTURE.md` §10.

### 1.2 The quota dialog could not open from server actions

The dialog needs `entitlement`, `limit`, `used`, `periodEnd` and
`upgradeRequired`. HTTP routes return them in the 429 body, but the two print
server actions threw `ActionError` with those fields in `details` — and Next.js
replaces a thrown server-action error with a sanitized message in a production
build, so the dialog could never read them.

Fix: limit trips are **returned**, not thrown, as a serializable
`EntitlementLimitSignal` (`src/lib/limit-signal.ts`,
`entitlementLimitSignal()` in `src/lib/entitlements.ts`,
`src/app/actions.ts`), and the dashboard opens the same dialog for a returned
signal or an HTTP error (`src/app/dashboard/dashboard-client.tsx`). The Odoo side
already received the same fields from the 429 body and maps them into
`GATEWAY_BILLING_LIMIT`.

## 2. Verified correct (no change needed)

**Quota cannot be exceeded or extended.** The print credit is consumed by a
single atomic upsert under `FOR UPDATE OF ts, p` and the tenant advisory lock, so
concurrent admissions on any number of Gateway instances stop exactly at the
limit; the idempotent-replay path returns before reserving, so a retry never
double-charges; only the canonical enqueue transaction inserts `print_jobs`, so
no code path can create a job without a credit; and the credit is written in the
same transaction as the job row, so a failed insert cannot bill for a job that
does not exist. Because usage is keyed by `current_period_start` (which only
Stripe writes), an upgrade mid-period keeps the existing usage against the new
limit, a downgrade immediately blocks further jobs when usage already exceeds the
new limit, and only a real Stripe period rollover starts a fresh bucket.

**Billing/payment.** Webhook handling is idempotent per `event_id`, serialized
per tenant with `FOR UPDATE`, fenced monotonically by
`stripe_last_event_created_at`, and reconciles from a freshly retrieved Stripe
subscription rather than the event snapshot; identity/customer/plan conflicts are
audited and ignored rather than applied. `checkout.session.completed` does not
grant entitlement by itself — access follows the live Stripe subscription status,
so an unpaid/incomplete subscription never provisions the runtime. Checkout
serializes per tenant with a persisted intent, an idempotency key and a
plan-conflict 409, and refuses to start a second subscription while Stripe owns a
blocking one. `Retry-After` values are always relative durations computed on the
Gateway clock.

**WebSocket and fallback.** Per-agent token buckets that survive reconnects,
in-flight and payload caps, socket caps, lifecycle-revision socket fencing,
tenant-suspension closes, `LISTEN`/`pg_notify` with reconnection plus a polling
fallback, and a safety poll even while the socket is up (recovers claims whose
delivery never arrived). Status transitions are fenced in the `UPDATE` predicate
(`claim_token IS NOT DISTINCT FROM <token>`), never by a read-then-write.

**Agent.** The Agent never compares a Gateway timestamp with its own wall clock:
ownership freshness uses monotonic deltas only, retry deferrals use the relative
`Retry-After`, the local SQLite ledger refuses to reopen a terminal job, and crash
recovery marks unknown outcomes instead of reprinting. Failover is bounded
(depth 3, visited set, protocol/capability parity, first attempt only), and the
Odoo outbox never re-POSTs once a Gateway job id exists.

## 3. Recommendations (product decisions, not defects)

1. **Repository hygiene**: `final-fix.patch` and `fix.patch` at the repository
   root are stale artifacts describing the removed SQLite-Gateway architecture
   (~400 KB). They should be deleted so they cannot be mistaken for pending work.
2. **Dead schema**: `print_job_rate_limits` has no readers or writers (rate
   limiting moved into plan entitlements). Drop it in a future migration.
3. **Odoo audit clock**: `completed_at` in `print_job.py` uses Odoo's host clock
   while `next_retry_at` uses `db_now_utc`. The value is display/audit only and
   never drives scheduling, but the two markers in the same write can disagree.
4. **`past_due` policy**: `past_due` intentionally keeps access while Stripe
   recovers payment, and the SQL gate does not apply the `current_period_end`
   check to it. Confirm the intended dunning window, since it is a revenue
   exposure rather than a technical defect.
5. **Agent SQLite driver**: `mattn/go-sqlite3` requires cgo, which complicates
   Windows cross-compilation; `modernc.org/sqlite` is the pure-Go alternative.

## 4. Verification

- `tests/database-clock.test.ts` — calibration behaviour, presence/subscription
  gates, signal shape, and source contracts (21 assertions).
- `tests/database-clock.integration.test.ts` — live calibration vs
  `clock_timestamp()`, the single-reading TTL invariant (`expires_at - created_at`
  is exactly the requested TTL), stored column defaults, quota-credit rollback
  with the enqueue transaction, and `used_prints` never above the limit.
- `tests/quota-dialog-render.test.ts` — renders the real dialog in jsdom from a
  limit signal (billing-period copy, used/limit, period end, upgrade path, rate
  vs concurrency wording, close behaviour).
- Unit suite: 511 passed / 1 skipped. Integration suite: 35 of 38 files pass.
  The three failing files fail only because this sandbox runs Node 22.22.3 while
  `crypto.argon2` requires Node 24.7+ (the project requires Node ≥ 24.15.0); no
  assertion related to this review fails.
- `tsc --noEmit`, `eslint .` and `next build` are clean; the production-like
  migration upgrade path replays 0067 without data loss.
