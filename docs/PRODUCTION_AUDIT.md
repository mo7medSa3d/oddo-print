# Production Audit — `oddo-print` (Yasser Cloud Printing Platform)

**Audit date:** 2026-09-24
**Branch:** `arena/01a0d158-oddo-print`
**Base commit:** `56d9e0f8cf327500ad7da6036af25b95a835ea2a`
**Scope:** whole repository, source-level, read-only
**Method:** full source reading. No fix was applied during this audit; every finding below is
either **SOURCE-PROVEN** (visible in the code) or explicitly marked **RUNTIME-ONLY UNOBSERVABLE**.

---

## 0. Method, evidence base, and environment limits

### 0.1 What was actually executed

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0, clean |
| `npx vitest run --config vitest.unit.config.mts` | **76 files passed / 1 skipped; 545 tests passed / 6 skipped** |
| `npx vitest run --config vitest.config.mts` (all) | **79 files passed / 38 skipped; 558 tests passed / 283 skipped**, 0 failures |
| `pytest tests/` (Python, venv with `cryptography`) | **75 passed** |
| `npm ci --engine-strict=false` | 469 packages installed |
| `npx drizzle-kit generate --out=/tmp/drz_out` | ran (out-dir was empty ⇒ produced a from-scratch script; **not** usable as a drift diff — see §5.4) |
| Go toolchain (`go build` / `go vet` / `go test -race`) | **not available** — see 0.2 |

Test results are recorded as evidence only. Per the completion gate, passing tests are **not** the
completion criterion; every subsystem below is graded on source reading.

### 0.2 Environment limits (RUNTIME-ONLY — never used to skip source inspection)

| Limit | Consequence |
|---|---|
| `go` not installed; `apt-get install golang-go` rejected (not root, dpkg lock); every Go mirror fails TLS (exit 35) | No `go build/vet/test/-race`. All Go findings are **pure source reading** (goroutine/channel/timer/lock tracing done by hand). |
| Node v22.22.3 present, project requires `>=24.15.0` | `crypto.argon2` paths (`src/lib/password.ts`) cannot execute here. Unit suite still fully passed. |
| No PostgreSQL server/client | `drizzle` migrations cannot be applied; the 38 skipped vitest files are the PG-dependent integration suite. Migration review is textual (§5). |
| `curl` egress blocked; `fetch_page` / `web_search` work | External documentation verification performed through those two tools (§20). |

### 0.3 Repository inventory (LOC)

| Area | Files | LOC |
|---|---|---|
| Gateway TypeScript/TSX (`src/`) | 669 total repo files | 29,718 TS/TSX |
| — API route handlers | 73 × `route.ts` | — |
| — `src/lib` modules | 54 | — |
| Go Agent (`agent/`) | 57 non-test + 49 test `.go` | 25,027 |
| Odoo addon (`odoo_addons/print_gateway/`) | 45 `.py` + XML/JS/SCSS | 13,365 |
| PostgreSQL migrations (`drizzle/`) | 71 SQL + `meta/` | 2,790 |
| Tauri desktop shell (`src-tauri/src/`) | 7 `.rs` | 2,918 |
| Tests | 124 files | 16,713 |

---

## 1. Odoo 19 addon — **COMPLETED**

### Files inspected
`__manifest__.py`; `runtime_clock.py`; `models/__init__.py`, `gateway_config.py` (2000),
`print_job.py` (1700), `print_router.py` (793), `binding.py` (604), `print_policy.py` (416),
`print_intent.py` (386), `crypto.py` (164), `runtime_assignment.py` (132), `pos_order.py` (72),
`pos_session.py` (22), `stock_picking.py` (35), `account_move.py` (31), `ir_actions_report.py` (43);
`controllers/__init__.py`, `pos.py`, `runtime_printers.py`; `security/ir.model.access.csv`,
`security/security.xml`; `data/cron.xml`; `views/*.xml` (7 files);
`static/src/js/{gateway_config_auto_sync, gateway_limit_dialog, pos_print_router,
pos_sale_details_router, report_interceptor}.js`, `static/src/js/tours/binding_cascade_tour.js`,
`static/src/components/{runtime_agent_field, runtime_printer_field}.js`; `migrations/1.1.0/pre-migrate.py`,
`migrations/19.0.1.1.0`, `19.0.2.1.0`, `19.0.2.3.0`, `19.0.2.4.0`, `19.0.2.6.0`, `19.0.2.7.0`,
`19.0.2.8.0`; addon tests (`tests/*.py`, 4231 LOC).

### Entry points
* Models: `print_gateway.gateway_config`, `.binding`, `.print_job`, `.policy`, `.intent`,
  `.runtime_agent_assignment`, `.pair_agent_wizard`.
* Controllers: `POST /print_gateway/runtime-agents`, `POST /print_gateway/runtime-printers`,
  `controllers/pos.py`.
* Hooks: `stock.picking._action_done`, `account.move.action_post`, `pos.order._process_saved_order`,
  `ir.actions.report` interception (`ir_actions_report.py`).
* Crons (4, `data/cron.xml`): `cron_submit_pending` (1 min), `cron_sync_status` (2 min),
  `cron_recover_pending_intents` (1 min), `cron_sync_enabled_state` (1 min).
* Migrations: 8 Odoo migration steps (1.1.0 + seven `19.0.2.x`).

### Important functions
`PrintJob._advance_status`, `_claim_submission_lease`, `_is_pre_dispatch_error`,
`_persist_durable_job`, `sync_status`, `action_reprint`;
`GatewayConfig._gateway_base/_gateway_headers`, write/create/migration/reconcile paths;
`PrintRouter.resolve_binding`, `route_intent`, `route_pos_receipt`, `route_kitchen_print`,
`route_pos_sale_details`;
`Binding._validate_runtime_target`, `_check_runtime_scope`, `dispatch_report_action`;
`Policy.render_raw_template`, `_sanitize_template_field`, `resolve_for_record`, `dispatch_for_record`,
`effective_target_key`, `matches_record`;
`Intent.compute_intent_key`, `_claim_intent`, `_finalize_intent_state`, `_execute_dispatched_route`,
`_dispatch_intent_postcommit`, `create_and_route`, `action_rearm_intent`, `cron_recover_pending_intents`;
`RuntimeAgentAssignment.assigned_agent_ids`, `is_agent_assigned`, `_check_admin`, `_check_assignment`;
`Crypto` (AES-GCM, deployment-key managed — migration `19.0.2.4.0`).

### Data flow
Odoo record event (`_action_done` / `action_post` / `_process_saved_order`) →
`Policy.dispatch_for_record` → `Intent.create_and_route` (durable, unique `intent_key`) →
`cr.postcommit` hook → `Intent._claim_intent` (independent cursor, fenced `claim_token`) →
`PrintRouter.route_intent` → `PrintJob.create` (outbox row, own committed cursor) →
`cron_submit_pending` / `_claim_submission_lease` → HTTP POST `/api/print/jobs` →
`cron_sync_status` reconciles terminal states back into Odoo.

### State machines
* `print_gateway.print_job.status` — closed enum with an explicit `_advance_status` transition table.
* `print_gateway.intent.status` — `pending → claimed → {dispatched, skipped, failed, pending}`;
  transition table enforced in `Intent.write` (`_VALID_INTENT_TRANSITIONS`); `dispatched` and
  `skipped` are terminal; `claimed → pending` requires either a matching `claim_token` **or**
  `allow_lease_recovery` context.

### Authorization boundaries
* `ir.model.access.csv`: every model read-only for `base.group_user`; write/create/unlink only for
  `base.group_system`; `print_gateway.print_job` has `perm_unlink = 0` even for admins.
* `security/security.xml`: `ir.rule` company isolation on all six models
  (`company_id in company_ids` / `branch_id in company_ids`).
* Controllers: `_require_runtime_admin()` requires `base.group_system`; `_scope()` validates company
  and branch membership against `env.companies`; `runtime_printers` additionally enforces
  `assigned_agent_ids()` ownership **and** re-verifies the agent is `active` in the tenant via the
  Gateway before returning any printer inventory.
* `dispatch_report_action` and the POS receipt/kitchen entry points call `records.check_access("read")`
  before any payload leaves Odoo.
* `RuntimeAgentAssignment.create/write` call `_check_admin()` (superuser or `base.group_system`)
  before touching scope fields.

### Source of truth
* **Odoo owns** company/branch scope, policies, bindings, intents, agent→branch assignment.
* **Gateway owns** job status, physical-outcome markers, agent/printer identity, entitlements.
* `print_gateway.intent.intent_key` (sha256 of `model:id:event:policy_id`) is the single
  idempotency authority for event-driven dispatch; `UNIQUE(intent_key)` is enforced at the DB level.

### Duplicate implementations searched
* Branch→agent authorization: `runtime_printers._assigned_runtime_agent_ids`,
  `binding._check_runtime_scope`, `print_router` — all three funnel into
  `RuntimeAgentAssignment.assigned_agent_ids`, which is explicitly documented as “the single source
  of truth”. **No divergent copy found.**
* Dedup: `Policy.effective_target_key` (in-memory, per-dispatch fan-out) vs
  `Intent.compute_intent_key` (durable, cross-worker). Different layers, intentionally; the policy
  key exists only to stop sibling policies collapsing before routing. **No conflict.**
* Clock: `runtime_clock.db_now_utc` used consistently — see *Confirmed correct behaviour*.

### Dead-code candidates
* None found at module level. All 14 manifest-listed data/asset files exist (verified
  programmatically: `MISSING: none`).
* `PrintGatewayPolicy.sanitize_raw_value` ESC/POS branch strips only DEL/C0 — narrow but intentional.

### External dependencies
`requests` (all Gateway HTTP), `cryptography` (`models/crypto.py` AES-GCM, env-managed key),
`odoo.tools.safe_eval.safe_eval` (policy domain filters), `odoo.sql_db` `postcommit`,
`ir.cron._commit_progress`. Odoo module deps: `base, web, sale, account, stock, purchase, point_of_sale`.

### Confirmed defects
* **DEFECT-ODOO-01 (documentation only, low).** `docs/CORRECTNESS_REVIEW.md` §3.3 claims
  “`completed_at` in `print_job.py` uses Odoo's host clock while `next_retry_at` uses
  `db_now_utc`”. Grepping all 20 `completed_at` writes in `print_job.py` shows **every** one now
  uses `db_now_utc(self.env.cr)` (lines 926, 1163, 1193, 1208, 1265, 1285, 1301, 1355, 1397, 1676).
  The remediation was completed but the recommendation was never retired ⇒ stale doc.

### Confirmed correct behaviour
* **Submission lease** (`_claim_submission_lease`, dedicated cursor, 120 s stale window) plus
  **pre-dispatch proof** (`_is_pre_dispatch_error`) means an ambiguous dispatch is terminalized as
  `unknown` instead of being retried or failed over — no duplicate print.
* Ambiguous/outcome-unknown Gateway markers (`_GATEWAY_UNKNOWN_MARKERS` mirroring the Gateway’s
  `PHYSICAL_OUTCOME_UNKNOWN_MARKERS`) never trigger failover and never auto-retry.
* `render_raw_template` blocks `.`, `[`, `__` in format fields **and** recursively rejects nested
  replacement fields inside format specs (`{x:{a.__class__}}` escape) — the classic sandbox escape
  is closed.
* `Intent._finalize_intent_state` is fenced by `claim_token`; a superseded lease logs
  “lease was superseded by another worker” and no-ops.
* `cron_recover_pending_intents` excludes exhausted failures **in SQL** (a domain cannot compare
  `attempts` to `max_attempts`), preventing permanent failures from starving the 50-row batch;
  it also terminalizes `claimed` intents that already hit the attempt ceiling.
* Policy scheduling failures are caught per-policy so one bad policy cannot block the others, and
  scheduling can never break `action_post` / `_action_done` / `_process_saved_order`.

### Unresolved questions
* `past_due` deliberately bypasses the `current_period_end` check (prior review §3.4). The intended
  dunning window is a product decision; not resolvable from source.
* `models.UniqueIndex("(company_id, runtime_agent_id) WHERE branch_id IS NULL")` — the
  partial-index (WHERE) form is not directly attested in the Odoo 19 sources I could reach (§20).
  Existence of `Constraint`/`Index`/`UniqueIndex` is confirmed; the WHERE predicate form is
  **UNVERIFIED**.

---

## 2. Gateway (Next.js core + API surface) — **COMPLETED**

### Files inspected
`src/db/schema.ts` (511); `src/lib/*.ts` (54 modules, incl. `print-job-service.ts`, `job-delivery.ts`,
`job-status.ts`, `job-maintenance.ts`, `job-fencing.ts`, `job-timeline.ts`, `entitlements.ts`,
`payload.ts`, `routing.ts`, `printer-model.ts`, `printer-virtual.ts`, `printer-health.ts`,
`printer-capability.ts`, `agent-auth.ts`, `odoo-auth.ts`, `manager-auth.ts`, `customer-auth.ts`,
`console-auth.ts`, `platform-auth.ts`, `authorization.ts`, `tenant-guard.ts`, `lifecycle.ts`,
`agent-lifecycle.ts`, `agent-availability.ts`, `agent-health.ts`, `database-clock.ts`, `audit.ts`,
`metrics.ts`, `stripe.ts`, `billing-operation.ts`, `tenant-lifecycle.ts`, `system-health.ts`,
`discovery.ts`, `ws-rate-limit.ts`, `request-limits.ts`, `limit-signal.ts`, `action-error.ts`,
`runtime-secret.ts`, `password.ts`, `worker-schema.ts`, `cache.ts`, `log.ts`, `tracing.ts`,
`idempotency.ts`, `network-address.ts`, `clipboard.ts`, `nanoid.ts`);
`src/app/actions.ts` (468); all 73 `src/app/api/**/route.ts` files; `src/server/ws.ts` (899),
`src/server/cors.ts`; `src/shared/job-vocabulary.ts`; `server.ts`.

### Entry points
73 HTTP route handlers under `src/app/api/**` (agent, print, jobs, printers, agents, odoo, auth,
billing, platform, team, metrics, system-health, onboarding, settings, certify, discovery);
8 server actions in `src/app/actions.ts`; WebSocket upgrade in `src/server/ws.ts`.

### Important functions
`createPrintJobForPrinter` (advisory locks, single `clock_timestamp()` read, atomic print-credit
upsert, `FOR UPDATE OF a,p` re-validation, `pg_notify`); `claimJobForAgent` / `job-delivery.ts`
(predicate-embedded fencing); `applyJobStatusUpdate` (`job-status.ts`); maintenance sweeps
(`job-maintenance.ts`); `enforceTenantResourceEntitlement`, `requireTenantBillingAccess`,
`getTenantEntitlementLimit`, `getTenantEntitlements`; `parsePrinterInput`,
`validateConnectionConfig`, `validatePrinterTransportProtocol`, `isAllowedPrinterDestination`;
`assertPrinterMetadataLimits`; `writeAuditEvent`; `derivePhysicalOutcome`; `databaseNowMs` /
`gatewayNow` / `refreshClockSkew`.

### Authorization boundaries (all verified present)
* `validateConsoleAuth` splits manager (JWT/cookie) from agent (bearer) from Odoo (API key).
* Every manager route calls `requireManagerPermission(claims, "<verb>.<noun>")`.
* Every tenant-scoped query is fenced with `eq(<table>.tenantId, ...)`; `print/jobs` re-validates
  printer+agent ownership inside the transaction.
* `platform/*` routes all use `requirePlatformOwner`; `admin/tenants/[id]/lifecycle` additionally
  gates on `PLATFORM_TENANT_ID`.
* CSRF-origin check (`tests/csrf-origin.test.ts`) and trusted-proxy handling.

### Confirmed defects
* **DEFECT-GW-01 (medium, scalability + changed-concept regression).**
  `src/app/actions.ts:415-418` — `getDashboardJobs` “unassigned” filter uses **untenant-fenced**
  subqueries:
  ```sql
  ${printJobs.printerId} NOT IN (SELECT id FROM printers WHERE lifecycle = 'active')
  ${printJobs.agentId}  NOT IN (SELECT id FROM agents  WHERE lifecycle = 'active')
  ```
  The identical filter in `src/app/api/jobs/route.ts:72-81` was already fixed and carries the
  comment *“The NOT IN subqueries were previously untenant-fenced full scans … fencing the
  subqueries by `tenant_id` lets PostgreSQL answer them with index-only scans”*, using
  `... WHERE tenant_id = ${printJobs.tenantId} AND lifecycle = 'active'`.
  The server action still has the pre-fix form. Impact: the dashboard polls this every 6 s
  (3 s while pairing) via `refreshData`, producing a full cross-tenant scan of `printers` and
  `agents` on each poll. **Not** a data leak (outer row is tenant-fenced and IDs are globally
  unique), but it is the exact defect the earlier fix targeted, surviving on a second path —
  i.e. the changed-concept sweep fails here.
* **DEFECT-GW-02 (low, clock-source inconsistency).** Four write sites stamp `updated_at` with the
  **host clock** (`new Date()`) while the rest of the codebase uses the database clock:
  * `src/app/actions.ts:276` — `setPrinterLifecycle` (`updatedAt: new Date()`), versus
    `src/app/api/printers/[id]/route.ts:128` which uses `updatedAt: sql\`now()\`` for the *same*
    mutation on the *same* row.
  * `src/app/api/settings/route.ts:28` and `src/app/api/onboarding/route.ts:53,59`
    (tenant name / subscription row).
  Every other writer (agent heartbeat, agent jobs, discovery, team, platform plans, billing)
  uses `sql\`now()\`` or `sql\`clock_timestamp()\``. The whole `src/lib/database-clock.ts`
  subsystem exists to make multi-instance deployments host-clock independent; these four sites
  opt out.
* **DEFECT-GW-03 (low, duplicated authorization predicate).** The “subscription is live” predicate
  is inlined verbatim in **at least 13 SQL sites**: `entitlements.ts` (6: lines 132, 148, 158, 188,
  283, 293), `job-delivery.ts` (2: 158, 189), `agent/jobs/route.ts` (4: 125, 165, 205, 237),
  `agent/register/route.ts` (1: 122), plus reporting copies in `platform/plans/route.ts:76` and
  `platform/stats/route.ts:49`. Substance is currently identical everywhere (status set,
  `current_period_end` check, `entitlement_blocked = false`), but:
  * `requireTenantBillingAccess` (line 133) uses **`clock_timestamp()`** while
    `getTenantEntitlementLimit` (149, 159), `getTenantEntitlements` (188, 283, 293),
    `job-delivery.ts` (158, 189) and `agent/jobs/route.ts` (all four) use **`now()`**.
    In PostgreSQL `now()` is frozen at transaction start; inside a long transaction that holds the
    enqueue/claim advisory locks, `now()` can evaluate a period that already expired as still live.
  * Adding any new block condition would require 13 coordinated edits.
  No bypass is possible today (all sites include `entitlement_blocked = false`).
* **DEFECT-GW-04 (informational, documented).** `src/app/api/agents/service-status/route.ts`
  returns a hardcoded `blocked: true` sandbox payload; it is not wired to the real Windows SCM.
  Documented in code, but it is a live endpoint that always reports “blocked”.

### Confirmed correct behaviour
* `print_jobs.status` is a closed enum with a TS transition table; the physical outcome is derived
  separately (`derivePhysicalOutcome`), so `success` deliberately carries
  `physical_outcome = "unknown"` — the system never claims paper came out.
* Job claiming is fenced **inside the UPDATE predicate** (`job-fencing.ts`, `job-delivery.ts`,
  `agent/jobs/route.ts`); there is no read-then-write claim anywhere. `SKIP LOCKED` +
  `FOR UPDATE OF p, a, pr, t` with a documented agent-row-first lock ordering prevents deadlock
  with heartbeats.
* Enqueue takes three advisory locks, reads `clock_timestamp()` **once**, upserts the print credit
  atomically, re-validates under `FOR UPDATE OF a,p`, and `pg_notify`s.
* Sweep constants: `STALE_CLAIM_SECONDS = 90`, `STALE_PRINTING_SECONDS = 600`, `MAX_RETRIES = 5`,
  `MAX_DELIVERY_ATTEMPTS = 5`.
* Printer destination validation (`printer-model.ts`) is a hard SSRF boundary: private/link-local
  only, `169.254.169.254` and `fd00:ec2::254` explicitly rejected, no embedded credentials, no
  query/fragment, protocol-specific port allowlists (network 9100; network+IPP 80/443/631;
  IPP 80/443/631), and `config.address` must agree with `config.ip:config.port`.
* Payload limits: `PRINTER_CONFIG_MAX_BYTES = 16 KiB`, `PRINTER_CAPABILITIES_MAX_BYTES = 32 KiB`,
  `MAX_PRINTERS_LIST = 1000`, `MAX_PRINTERS_OFFSET = 10 000`.
* `POST /api/jobs/[id]/reprint` requires a **terminal** job (`isTerminal`) and the
  `jobs.retry` permission; it creates a fresh job (no idempotency key by design, because a
  reprint is an explicit new physical print).

### Unresolved questions
* Whether `past_due` should eventually be bounded by `current_period_end` (product decision,
  prior review §3.4).

---

## 3. PostgreSQL — **COMPLETED**

### Files inspected
`drizzle/0000_*.sql` … `drizzle/0070_*.sql` (71 files, 2 790 LOC, 196 `statement-breakpoint`s);
`drizzle/meta/_journal.json`, `drizzle/meta/0000_snapshot.json`, `drizzle/meta/0028_snapshot.json`;
`src/db/schema.ts`; `scripts/db-migrate.ts`; `tests/migration-journal.test.ts`,
`tests/migration-upgrade.integration.test.ts`, `tests/architecture-pg.test.ts`.

### Source of truth
`src/db/schema.ts` (Drizzle) is the declared source of truth; `drizzle/*.sql` is the ordered
deployment history; `drizzle/meta/_journal.json` is the ordering authority consumed by
`migrate()` in `scripts/db-migrate.ts`.

### Important structures
24 tables: `agents`, `api_keys`, `applications`, `audit_events`, `auth_rate_limits`,
`billing_events`, `discovery_sessions`, `discovered_devices`, `email_verification_tokens`,
`gateway_metrics`, `job_events`, `manager_sessions`, `password_reset_tokens`, `plans`,
`platform_sessions`, `print_job_rate_limits`, `print_jobs` (24 cols / 10 indexes / 4 FKs),
`print_usage_periods`, `printers` (20 cols), `tenant_domains`, `tenant_invitations`,
`tenant_subscriptions` (24 cols), `tenant_users`, `tenants`, `users`.

### Confirmed correct behaviour
* Journal integrity is enforced by an automated test (1-to-1 SQL-file ↔ `_journal.json`, `idx == i`,
  filename == tag). It passes.
* Composite tenant-scoped uniqueness/indexes exist on every tenant-owned table
  (`*_tenant_id_unique`), which is what makes the fenced subqueries in `api/jobs/route.ts`
  index-only.
* No uncontrolled destructive DDL: the only `DROP TABLE`/`DROP COLUMN` statements are in
  `0006`, `0011`, `0020`, `0021`, `0022`, `0028` — all part of the historical removal of the
  pre-multi-tenancy `branches`/`destinations`/`local_networks`/`document_types`/`printer_bindings`
  architecture (see §17 changed-concept sweep).
* `0069_redact_legacy_claim_ids` and `0068_billing_entitlement_block` are additive hardening.

### Confirmed defects
* **DEFECT-PG-01 (low, no runtime impact today).** `drizzle/meta/` contains only
  `0000_snapshot.json` and `0028_snapshot.json`. Drizzle-kit computes the next migration by diffing
  `schema.ts` against the **latest** snapshot (0028). Running `npm run db:generate` therefore
  produces a single migration containing the entire 0028→HEAD delta, re-issuing DDL that
  migrations 0029-0070 already applied. `db:migrate` (which replays the journal in order) is
  unaffected, but the generate workflow is booby-trapped.
* **DEFECT-PG-02 (dead schema).** `print_job_rate_limits` is created by `0016` and `0028`, declared
  in `schema.ts:505`, referenced in `0028_snapshot.json`, by a test cleanup helper
  (`tests/helpers/pg.ts:89`) and by a migration-tag assertion
  (`tests/production-hardening-contract.test.ts:95`) — and by **no application code**.
  Verified: zero reads, zero writes, zero imports outside those five places. Rate limiting moved to
  plan entitlements (`max_jobs_per_minute`, `max_concurrent_jobs`).

### Unresolved questions
* Whether migrations 0029-0070 have ever been replayed end-to-end on a populated database outside
  this repo (the repo has an integration test for it, which cannot run here — no PG server).
  **RUNTIME-ONLY UNOBSERVABLE.**

---

## 4. WebSocket layer — **COMPLETED**

### Files inspected
`src/server/ws.ts` (899 lines); `src/lib/ws-rate-limit.ts`; `src/lib/agent-auth.ts`;
`src/lib/agent-lifecycle.ts`; `src/lib/tenant-guard.ts`; `src/lib/database-clock.ts`;
tests `ws-claim-delivery`, `ws-listener-setup-race`, `ws-route-ownership`, `ws-session-fencing`,
`ws-socket-cap`, `tenant-suspension-socket`.

### Important functions
Socket registry + lifecycle fencing; PG `LISTEN/NOTIFY` listener with reconnect; token buckets
(`ws-rate-limit.ts`); `claimAndPushJobToAgent`; `handleAgentMessage` (job_ack handling);
`publishAgentSessionClose` / `publishTenantSessionClose` (exported, used by lifecycle code);
`__clearWsBucketsForTests` / `__pruneIdleWsBucketsForTests` (test-only).

### Data flow
Enqueue `pg_notify` → PG listener → tenant/socket routing → `claimAndPushJobToAgent`
(fenced claim, then push) → agent `job_ack` → `handleAgentMessage` → `job-status` update.
Polling (`GET /api/agent/jobs`) is the fallback and uses the **same** fenced claim SQL.

### Confirmed correct behaviour
* **Delivery-evidence rule:** if the job row cannot be durably marked as delivered before the push,
  the job is written as `UNKNOWN_PARTIAL_DELIVERY` **and terminalized as `failed`** — it is never
  requeued. This is the single most important anti-duplicate-print guarantee in the Gateway.
* Socket lifecycle is fenced (generation/ownership checks) so a stale socket cannot ack a job it no
  longer owns; tenant suspension closes sockets explicitly.
* Listener reconnect is handled; the `ws-listener-setup-race` test locks the setup ordering.
* Token buckets bound both connect and message rates; socket cap enforced.

### Confirmed defects
* **DEFECT-WS-01 (dead code, low).** `isWsUpgradeLocallyLocked` is exported from
  `src/lib/ws-rate-limit.ts` and referenced nowhere; `publishAgentSessionClose` and
  `publishTenantSessionClose` are exported from `ws.ts` but consumed only by tests
  (`__clearWsBucketsForTests`, `__pruneIdleWsBucketsForTests` likewise). Three exported symbols
  are therefore unreachable from production code.

### Unresolved questions
None material. Behaviour under sustained PG reconnect storms is exercised by tests that pass but
cannot be reproduced here (no PG server). **RUNTIME-ONLY UNOBSERVABLE.**

---

## 5. Go Agent — **COMPLETED** (source-only; toolchain unavailable)

### Files inspected
`cmd/agent/main.go`, `cmd/cli/main.go`; `internal/agent/agent.go` (2 420), `internal/agent/desired_state.go`;
`internal/queue/queue.go` (414); `internal/config/config.go`, `security_windows.go`;
`internal/storage/secure.go`, `security_windows.go`;
`internal/printer/{printer,document,outcome,factory,network,spooler_windows,ipp,usb_windows,pdf,
pdf_windows,pdf_other,image,classify,classify_device,capability,raster_capability,health,registry,
stable_id,peripherals}.go`; `internal/discovery*`, `internal/diag`, `internal/integration`.
57 non-test `.go` files, 25 027 LOC, plus 49 test files read as specification.

### Goroutine / channel / timer inventory (hand-traced)

| Concern | Implementation | Verdict |
|---|---|---|
| Main run loop | `Run()` with `context` + shutdown channel; `maxConcurrentJobs = 8` semaphore | bounded |
| Job queue | `maxPendingJobs = 64`, `maxPendingJobsPerPrinter = 8`, `maxClaimBatch = 20` | bounded |
| Reject/ACK queues | `maxRejectQueue`, overflow falls back to “gateway claim lease is the authoritative recovery backstop” (agent.go:1333-1356) | bounded, documented |
| Heartbeat | paginated (500/page), per-printer single-flight probe capped at 64 concurrent | bounded |
| Print timeout | `printDocumentTimeout = 2m + 30s/MB` | bounded |
| WS idle | `wsIdleTimeout = 90s` | bounded |
| Stale claim | `staleClaimSafetyWindow = 90s`, mirrors Gateway `STALE_CLAIM_SECONDS` | consistent |
| Timers | `time.After`/`Ticker` all created inside loops with explicit stop or context-bound | no leak found by reading |
| Shutdown | `service.Stop` → context cancel → in-flight dispatch drain → `MarkInterrupted` | ordered |

**Race/deadlock/leak/starvation search (by reading):** no channel send without either a buffered
capacity, a `select` with `ctx.Done()`, or a documented single-consumer; every long-lived goroutine
is joined or context-bound; the per-printer session mutex in `spooler_windows.go` and the single
`sync.Mutex` in the discovery `add()` closure are the only hot locks and neither is held across
I/O. **No deadlock, leak, or starvation found by source inspection.** Note this is *not* a
`-race` run — see 0.2.

### SQLite ledger (duplicate-print barrier)
`queue.BeginPrint` refuses to open a job whose ledger row is terminal (`ErrTerminalState`); a
success row is **permanently terminal**; unknown-outcome failed rows reopen only under the
**opt-in** `reprint_after_crash` setting; `AbortPrint` rolls back attempts that provably wrote zero
bytes; `MarkInterrupted` runs at startup **before** any new delivery is accepted
(`agent.go:642`, and `ws_delivery_test.go:486` asserts “startup recovery must never print”).

### Windows integration
`kardianos/service` (`YasserAgent`, depends on `Tcpip`, outbound-only description);
`configureServiceRecovery` shells `sc.exe failure … reset= 86400 actions= restart/60000/restart/60000/restart/60000`
(warn-only, never breaks install); log rotation via `lumberjack` (10 MB × 3) into
`%PROGRAMDATA%\YasserAgent\logs` with 0700 + hardened ACLs; agent secret stored via DPAPI;
`config.EnsureSecureDirectoryACL` / `EnsureSecureFileACL`.

### Confirmed correct behaviour
* `authorizeDispatchAfterReportFailure` hard-stops on `ErrStaleClaim` / `ErrTransitionRejected`; a
  transport failure proceeds only if the delivery receipt is `< 90 s` old (no TTL/host-clock
  comparison — the monotonic ownership window is used instead).
* `desired_state.go` `isPrinterExecutionAllowed` refuses dispatch unless the printer is synced,
  applied, observed, and not tombstoned; gateway-owned IDs + tombstones are echoed back as an
  ownership fence; network destinations are re-validated on the agent (defence in depth behind the
  Gateway SSRF gate).
* HTTPS enforced unless `YASSER_AGENT_ALLOW_INSECURE_HTTP=1`.
* LPR discovery (`probeLPRHost`) sends the LPD **queue-status** byte `0x04`, never the
  receive-job byte `0x02`, and its results are deliberately never registered
  (“LPR execution is not supported; candidates were not registered”) — discovery cannot print.

### Confirmed defects
None that are source-proven. All agent defects recorded by the prior review
(`docs/CORRECTNESS_REVIEW.md`) are present in the working tree as fixed code, verified by reading
`queue.UpdateStatus` (terminal branch clearing `claim_token`), `cmd/cli/main.go:183` (fail-closed
`config.Ensure`), and the crash-recovery path.

### Unresolved questions
* Concurrency correctness is asserted by 49 Go test files including `dispatch_test.go`,
  `ws_delivery_test.go`, `desired_state_test.go`, `hardening_test.go`, `results_close_race_test.go`.
  **Those cannot be executed here — the Go toolchain is unavailable (0.2).** This is a
  RUNTIME-ONLY gap, explicitly not a substitute for the source review above.

---

## 6. Windows integration — **COMPLETED**

### Files inspected
`agent/cmd/agent/main.go` (service install/uninstall/start/stop/restart/status, recovery config,
logging); `agent/internal/config/security_windows.go` (ACL helpers);
`agent/internal/storage/security_windows.go` (DPAPI);
`agent/internal/printer/spooler_windows.go` (754), `usb_windows.go` (655),
`pdf_windows.go` (481), `discovery_windows.go`, `registry.go`;
`src-tauri/src/agent.rs` (866), `paths.rs` (169), `commands.rs` (1 374), `tray.rs`, `cleanup.rs`,
`logging.rs`, `main.rs`; `scripts/build-windows-installer.ps1`, `scripts/smoke-test-windows.ps1`;
`docs/WINDOWS_SERVICE_RECOVERY.md`.

### Confirmed correct behaviour
* `%PROGRAMDATA%\YasserManager` / `%PROGRAMDATA%\YasserAgent` only — **no per-user fallback**, so
  the desktop app and the LocalSystem service share one home (no split brain).
  Non-elevated launch warns and continues; every mutating operation fails closed with an explicit
  “run as administrator” message (`paths::admin_required_error`).
* `agent::system32_exe(name)` rejects any name containing `/` or `\` and requires the resolved
  `%SystemRoot%\System32\<name>` to be a real file before `sc.exe`/`net.exe`/`taskkill.exe` is
  spawned — no PATH hijack.
* `agent::stop()` refuses to kill by image name: it requires a recorded `BackgroundProcessRecord`,
  re-verifies image path **and** creation time (`process_identity`), re-verifies after the graceful
  window, and only then force-terminates the same PID.
* All child processes run through `run_bounded_command` (kill on timeout, per-stream output caps)
  with `CREATE_NO_WINDOW` (and `DETACHED_PROCESS` for the background agent).
* SCM recovery: 3 × `restart/60000`, counter reset daily, warn-only.

### Confirmed defects
None source-proven.

### Unresolved questions
* `src-tauri/src/commands.rs::register_printer` and `test_printer` spawn the bundled CLI with
  `-config %PROGRAMDATA%\YasserAgent\config.yaml`. Behaviour on a machine where the agent was
  installed to a different data root is untestable here (Windows-only).
  **RUNTIME-ONLY UNOBSERVABLE.**

---

## 7. Printer execution — **COMPLETED**

### “CAN THIS PRINT TWICE?” — per transport

| Transport | Source | Verdict & proof |
|---|---|---|
| **Network (RAW TCP 9100)** | `printer/network.go` | **No.** Dial failure ⇒ plain pre-dispatch error (safe, retryable). Any failure *after* the first confirmed byte ⇒ `MarkUnknown("UNKNOWN_PARTIAL_DELIVERY")`, which the Gateway terminalizes as `failed` and never requeues. |
| **Windows spooler** | `printer/spooler_windows.go` (754) | **No.** Same marker after any written bytes. `EndPagePrinter`/`EndDocPrinter` failure ⇒ unknown. Bounded preflight + per-printer session mutex + 30 s post-cancel wait ⇒ unknown. |
| **USB (direct kernel write)** | `printer/usb_windows.go` (655) | **No.** `p.wedged` latch refuses new dispatch after a stalled write until restart; every failure after the write helper is spawned is `MarkUnknown` unless provably zero bytes; ctx cancellation before the helper is a plain error. |
| **IPP / IPPS** | `printer/ipp.go` (509) | **No.** `preDispatchIRErr` classifies dial/DNS errors as pre-dispatch (retryable); everything else is unknown. PDF is validated before submission; empty and >`maxPrintBytes` payloads are refused. |
| **PDF rendering (PDFium/wazero)** | `printer/pdf.go`, `pdf_windows.go` (481) | Rendering is in-process; a render failure occurs strictly before any transport write ⇒ always pre-dispatch. |
| **Image** | `printer/image.go` (241) | Same: rasterization precedes any write. |
| **Discovery probes** | `discovery*.go` | **Cannot print at all.** TCP-9100 and IPP probes only connect / send Get-Printer-Attributes; SNMP is a read-only `Get` on `public`; LPR sends only the queue-status command and its results are discarded by design. |

### “WHAT EXACTLY DOES SUCCESS PROVE?” — per success path

| Success signal | Proves | Does **not** prove |
|---|---|---|
| Agent print transport returns without error | The full byte stream was accepted by the OS socket / spooler job / kernel device write | Physical paper was produced. `derivePhysicalOutcome("success") ⇒ "unknown"` everywhere — Gateway, web console and desktop all render `success` as “Delivered to printer”, and `jobGuidance` explicitly says *“Physical paper output is not independently verified.”* |
| Spooler `EndDocPrinter` returns success | The Windows spooler accepted and queued the document | That the printer is powered, has paper, or did not jam afterwards. |
| IPP response `successful-ok` | The IPP server accepted and queued the job | Physical output. |
| Gateway job `success` | The agent reported transport success and the job was acked | Physical output — the system is deliberately honest about this. |

This is a consistently honest model: **no success path anywhere claims physical paper.**

### Confirmed defects
None source-proven.

---

## 8. Printer discovery — **COMPLETED**

### Files inspected
`internal/printer/discovery.go` (946), `discovery_extended.go` (607), `discovery_windows.go`,
`discovery_other.go`, `network_discovery.go` (454), `ipp_discovery.go` (396),
`snmp_discovery.go` (208), `wsd_discovery.go` (334), `stable_id.go`, `classify.go` (270),
`classify_device.go` (547), `registry.go` (297), `peripherals.go`.

### Design
`DiscoverWithContext` fans out **10 concurrent sources**, each in its own goroutine with a
`recover()` and a bounded sub-context:
1. config file (legacy YAML), 2. spooler, 3. registry (previously discovered / manual),
4. network TCP 9100 (10 s), 5. USB SetupDi, 6. IPP mDNS + TCP 631 (10 s),
7. LPR/LPD 515 (8 s, ≤254 targets), 8. SNMP 161 (8 s, ≤100 targets),
9. WSD multicast (4 s), 10. full mDNS (4 s).

Dedup: stable ID first (`StableIDFrom{Spooler,USB,Network,Endpoint}`), then cross-source merge on
`NetworkAddress:Port`, then USB merge requiring a **strong** identity (VID/PID alone is explicitly
*not* accepted — “merging two identical USB printers with no serial/location evidence would hide
one device”). Non-production devices are dropped twice — `isValidDiscoveredPrinter` then
`IsProductionPrinter`, the latter logging the classification and reasons.

### Confirmed correct behaviour
* Discovery is strictly additive and never sends printable data (see §7).
* Protocol is left **empty** when it cannot be proven — the comment records that “inventing `raw`
  here was the wildcard bug”.
* Bounded target lists (`≤254` LPR, `≤100` SNMP) and worker pools (`16` for LPR) prevent scan
  storms.

### Confirmed defects
None source-proven.

### Unresolved questions
* Cross-scan convergence relies on `discovered_devices.identity_key` (migration 0070). Whether an
  already-populated production table converges as intended after 0070 is a data question.
  **RUNTIME-ONLY UNOBSERVABLE** (no PG server).

---

## 9. UI (web console + desktop manager) — **COMPLETED**

### Files inspected
Web: `src/app/dashboard/dashboard-client.tsx` (1 335), `src/app/page.tsx` (656),
`platform/dashboard/page.tsx` (503), `team/page.tsx` (399), `billing/page.tsx` (366),
`pricing/page.tsx` (218), `platform/plans/page.tsx` (211),
`release-readiness/release-readiness-client.tsx` (208), `settings/page.tsx` (180),
`platform/tenants/page.tsx` (182), `login/page.tsx` (165), `platform/login/page.tsx` (133),
`dashboard/page.tsx` (136), `onboarding/page.tsx` (232), `api-keys/page.tsx` (251),
`signup`, `verify-email`, `forgot-password`, `reset-password`, `invite`, `platform/audit`,
`platform/subscriptions`, `system-health`;
`src/components/ui.tsx` (1 077) plus `JobTimeline`, `JobCleanupButton`, `PrintCertificationWizard`,
`UpgradeLimitDialog`, `AgentHealthMatrix`, `PrinterCapabilityMatrix`, `BillingActions`,
`AppShell`, `TopNavbar`, `ThemeToggle`, `brand`;
`src/shared/job-vocabulary.ts`, `src/lib/clipboard.ts`, `src/lib/idempotency.ts`,
`src/lib/limit-signal.ts`, `src/lib/printer-capability.ts`, `src/lib/printer-virtual.ts`.
Desktop: `src/desktop/main.tsx` (1 093), `lib/ipc.ts`, `lib/printers.ts`, `types.ts`,
`pages/{Overview,Printers,Jobs,Agents,Settings}.tsx`,
`components/{AddPrinterDialog (373), EditPrinterDialog (267), AdminPrivilegeDialog, Sidebar, JobTimeline}.tsx`.

### Every form/control traced

| Surface | Source field | UI state | Init | Persisted | API | Save path | Reload | Validation | Disabled | Error | Async |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard → Register agent | `agentName` | `useState("")`, `maxLength=200`, `required` | empty | none | `POST /api/agents` (fetch, `same-origin`) | `handleCreateAgent` → `setActivePairing`, `refreshData()` | 6 s / 3 s poll, skipped when `document.hidden` | `!agentName.trim()` disables submit; `busy`; `databaseError !== null` | yes | `DashboardApiError`; `MAX_AGENTS_EXCEEDED` → `UpgradeLimitDialog` | `setBusy` in `try/finally` |
| Dashboard → agent lifecycle | `setAgentLifecycle` | `pendingAgentAction` modal | n/a | DB (tx + audit) | server action | `runAction` → `refreshData()` | yes (poll) | `canTransitionLifecycle` server-side; UI confirms disable/retire | `busy` | toast; session-expiry → `/login` | `setBusy` in `finally` |
| Dashboard → printer lifecycle | `setPrinterLifecycle` | inline buttons | n/a | DB | server action | `runAction` → `refreshData()` | yes | server-side transition table; test-print disabled when `lifecycle !== "active"` | `busy` | toast | `setBusy` |
| Dashboard → test print | `sendGatewayTestPage` | `testingPrinterId` | null | creates a job | `POST /api/printers/{id}/test-print` + `Idempotency-Key` | toast + `refreshData()` | yes | disabled unless printer active and no other test in flight | yes | `DashboardApiError` → limit dialog | `setTestingPrinterId` in `finally` |
| Dashboard → **reprint** | `sendGatewayReprint` | `reprintCandidate` modal | null | creates a **new** job | `POST /api/jobs/{id}/reprint` | toast + `refreshData()` | yes | `isTerminal` server-side (409 otherwise); confirm dialog warns “duplicate possible” | **see DEFECT-UI-01** | toast | **see DEFECT-UI-01** |
| Dashboard → job filters | `jobStatusFilter`, `jobSearch` (250 ms debounce) | `debouncedJobSearch`, `filterRef` | all/““ | none | `getDashboardJobs` server action | — | `cancelled` flag guards setState | `limit: 100` | — | `console.error` only | yes |
| Dashboard → job payload | `selectedJob.payload` / `selectedJobPayload` | `undefined` = loading | lazy fetch on drawer open | none | `GET /api/jobs/{id}` | — | — | 64 KiB preview truncation + Copy button | — | `null` on failure | `cancelled` guard |
| Settings → workspace name | `name` | `minLength=2 maxLength=120` | `GET /api/settings` | DB | `PATCH /api/settings` | toast | once on mount | HTML + server | `busy` | toast | `setBusy` |
| Settings → **Security tab** | — | two static cards | — | — | — | — | — | — | — | — | **see DEFECT-UI-02** |
| Desktop → Gateway URL | `gatewayUrl` | `savedGatewayUrl`, `checkedGatewayUrl`, `gatewayChecking` | `get_gateway_config` | `settings.json` (`set_gateway_config`) | `GET /api/health` then persist | `checkHealth` | on change | `normalizeGatewayUrl` (whitespace/scheme/credentials/query/fragment) | `gatewayChecking` | `healthError` with `friendlyGatewayError` | `setGatewayChecking` in `finally` |
| Desktop → pairing code | `pairCode` | `busy` | empty | agent `config.yaml` via Rust | `pair_agent` → bundled CLI | `pair` → `refreshStatus/Printers/Jobs` | yes | non-empty + gateway URL set; Rust re-validates 6-char alphabet | `busy` | `friendlyAgentError` | `setBusyBoth` in `finally` |
| Desktop → Add printer | name/conn/spooler/host/port/protocol/ippUrl/usbSel/agentId | `error`, `busy`, `upgradeLimit` | reset on open | Gateway | `POST /api/printers` via agent transport | `handleSubmit` → `onSuccess` | yes | `validate()` (gateway URL, active agent, per-connection rules, port 9100, IPP scheme) | `busy` | `friendlyPrinterError` (never rewrites unknown-outcome markers) | yes |
| Desktop → printer lifecycle | `updatePrinterLifecycle` | `busy` | — | Gateway (manager PATCH) | `PATCH /api/printers/{id}` via **manager** transport | `refreshPrinters()` | yes | `window.confirm` for retire | `busy` | toast | `setBusyBoth` |
| Desktop → autostart | `autostart` | `setAutostartState` | `get_autostart` | marker file + OS | `set_autostart` | marker write **after** OS success, OS rollback on marker failure | yes | — | — | toast | yes |

### Confirmed defects
* **DEFECT-UI-01 (medium-low, web console).** The reprint confirmation handler
  (`src/app/dashboard/dashboard-client.tsx:1283-1298`) **never calls `setBusy(true)`**. It is the
  only mutating action in the dashboard that does not. Consequences:
  * the confirm button’s `disabled={busy}` / `loading={busy}` never engage during the request —
    no in-flight feedback;
  * the drawer’s “Reprint…” / “Retry print…” buttons (`disabled={busy}`, lines 1206, 1213) stay
    enabled while a reprint is in flight, so an operator can open a second confirm dialog and
    create a second physical print;
  * `Modal onClose={() => { if (!busy) setReprintCandidate(null); }}` can never enter its
    “busy ⇒ ignore close” branch.
  The window is narrow (the modal unmounts on first confirm, so a literal double-click on the same
  button is prevented), but the guard that exists on every other mutation is simply absent here,
  on the **one** action that deliberately creates a duplicate print.
* **DEFECT-UI-02 (low, web console).** `src/app/settings/page.tsx` declares a
  `{ id: "security", label: "Security", desc: "Account security" }` nav item, but the
  `activeTab === "security"` branch renders a Card containing two boxes whose only content is the
  titles “Session persistence” and “Transport” — **no controls, no text, no data**. The tab is a
  placeholder shipped as a finished feature.

### Confirmed correct behaviour
* One shared status vocabulary (`src/shared/job-vocabulary.ts`) is used by the web console, the
  desktop app and (by mirrored marker list) the Odoo addon; a unit test locks
  `UNKNOWN_OUTCOME_MARKERS` to the Gateway’s `PHYSICAL_OUTCOME_UNKNOWN_MARKERS`.
* `friendlyPrinterError` refuses to reword unknown-outcome markers into “did not respond” — the
  comment states this exists specifically to stop operators reprinting and double-printing.
* Desktop error mapping never leaks config paths, stack backtraces or panics
  (`/[A-Za-z]:\\/` → generic message).
* All desktop Gateway traffic goes through the Rust boundary (`gateway_request` /
  `gateway_agent_request`); browser `fetch` throws if called under Tauri.
* `agentLiveView(agent)` (default `nowMs = Date.now()`) is re-evaluated on every render, and the
  5 s `nowMs` ticker forces re-render ⇒ KPI counts and per-row badges cannot diverge.

### Unresolved questions
* `src/components/ui.tsx` (1 077 lines) exposes `Modal`/`Drawer`/`Select`/`Input`/`Field`;
  jsdom coverage exists (`dialog-isolation`, `form-accessibility`, `desktop-ui-smoke`) and passes,
  but real-browser keyboard/focus behaviour is **RUNTIME-ONLY UNOBSERVABLE** here.

---

## 10. Configuration — **COMPLETED**

### Sources inspected
`package.json` (engines `node >=24.15.0`; scripts; 11 runtime deps, 24 dev deps);
`agent/go.mod` (`go 1.26`; 11 direct + 7 indirect);
`src-tauri/Cargo.toml` (tauri `=2.11.5`, `tauri-plugin-autostart 2`, `reqwest 0.13.4` with
`rustls` and **no default features**, `url 2.5.7`; release profile `lto`, `codegen-units=1`,
`strip`, `panic = unwind` so the panic hook can log);
`next.config.*`, `tsconfig.json`, `vite.desktop.config.mts`, `vitest*.config.mts`,
`drizzle.config.ts` (fails fast when `DATABASE_URL` is unset — no credential fallback),
`.gitignore`, `odoo_addons/print_gateway/__manifest__.py`
(`external_dependencies: {'python': ['requests','cryptography']}`).

### Runtime configuration surfaces
* Gateway: `DATABASE_URL` (required), Stripe keys, `PLATFORM_TENANT_ID`, trusted-proxy settings,
  clock-skew calibration (`src/lib/database-clock.ts`).
* Agent: `%PROGRAMDATA%\YasserAgent\config.yaml`, `YASSER_AGENT_DATA_DIR`,
  `YASSER_AGENT_ALLOW_INSECURE_HTTP`, `reprint_after_crash` (opt-in).
* Desktop: `%PROGRAMDATA%\YasserManager\settings.json` (gateway URL only), autostart marker file,
  debug-only `YASSER_*_DATA_DIR` overrides (`#[cfg(debug_assertions)]` only).
* Odoo: `print_gateway.gateway_config` records + deployment key env var for `crypto.py`.

### Confirmed correct behaviour
* No credential defaults anywhere; `drizzle.config.ts` throws with a descriptive message rather
  than falling back.
* Debug-only path overrides are `#[cfg(debug_assertions)]`-gated in `src-tauri/src/paths.rs`, so a
  release build can never be redirected to a writable-per-user data root.
* `reqwest` built with `default-features = false` + `rustls` ⇒ no OpenSSL dependency on Windows.

### Confirmed defects
None source-proven.

### Unresolved questions
* `go 1.26` in `agent/go.mod` could not be validated against an installed toolchain
  (0.2). Whether the pinned dependency set still resolves (`go.sum` not independently verified)
  is **RUNTIME-ONLY UNOBSERVABLE**.

---

## 11. Dependencies — **COMPLETED**

### Inventory
* Node: `next 16.3.6`, `react 19.3.0`, `drizzle-orm 0.45.2`, `drizzle-kit 0.31.10`, `pg 8.23.0`,
  `ws 8.21.3`, `zod ^4.6.1`, `@tauri-apps/api ^2.11.1`, `clsx`, `tailwind-merge`,
  `lucide-react ^1.41.0`, `tsx`, `vitest 5.0.1`, `eslint 9`, `typescript`.
* Go: `gorilla/websocket 1.5.3`, `gosnmp/gosnmp 1.44.0`, `grandcat/zeroconf 1.0.0`,
  `kardianos/service 1.3.0`, `klippa-app/go-pdfium 1.19.8`, `mattn/go-sqlite3 1.14.50`,
  `tetratelabs/wazero 1.12.0`, `golang.org/x/sys 0.47.0`, `lumberjack.v2 2.2.1`, `yaml.v3`;
  indirect `miekg/dns 1.1.27`, `golang.org/x/{crypto 0.54.0, net 0.57.0, text 0.40.0}`,
  `google/uuid 1.6.0`, `jolestar/go-commons-pool/v2 2.1.2`, `cenkalti/backoff 2.2.1+incompatible`.
* Rust: `serde`, `serde_json`, `tauri =2.11.5`, `tauri-plugin-autostart 2`, `url 2.5.7`,
  `reqwest 0.13.4`.
* Python: `requests`, `cryptography` (declared in the Odoo manifest).

### Confirmed findings
* **DEFECT-DEP-01 (low, build ergonomics).** `mattn/go-sqlite3` requires cgo, which complicates
  Windows cross-compilation. This is the prior review’s recommendation §3.5 and remains open.
  `modernc.org/sqlite` is the pure-Go alternative.
* `miekg/dns v1.1.27` is an old indirect dependency pulled in by `grandcat/zeroconf` (mDNS).
  It is only reachable through local multicast discovery.
* Node engine floor (`>=24.15.0`) is real but strict: the entire unit suite passes on Node 22.22.3,
  so the floor is driven by `crypto.argon2` in `src/lib/password.ts` rather than by the framework.

### Unresolved questions
* No vulnerability database was reachable from this sandbox (egress limited to the two research
  tools). A CVE scan of the pinned versions is **not performed**; none of the versions above is
  known-bad from the source alone, but this is an explicit gap rather than a clean result.

---

## 12. Dead code — **COMPLETED (repository-wide, not changed-files-only)**

Method: for every exported symbol in `src/lib`, `src/server` and `src/shared`, grep the whole of
`src/` **and** `tests/`; classify a symbol as dead only when no production file imports it and any
test reference is a source-text assertion (not an import).

### Fully dead modules
| Module | Evidence |
|---|---|
| `src/server/cors.ts` | Whole module. Only reference in the repo is `tests/desktop-auth-contract.test.ts:49` doing `read("src/server/cors.ts")` (source-text assertion). Zero imports. |
| `src/lib/tracing.ts` | Whole module (6 exports). Only reference is a **string literal** in `src/app/release-readiness/release-readiness-client.tsx:65`. Zero imports. |
| `src/lib/agent-presence-maintenance.ts` | Whole module (`sweepStaleAgentPresence`, `AGENT_PRESENCE_SWEEP_INTERVAL_MS`). Only reference is `tests/production-fixes-contract.test.ts:214` reading the source text. **No scheduler invokes it**, so agent presence is never swept by this code path. |
| `src/server/api-defaults.ts` | `applyApiCacheControlDefault` is imported only by `tests/server-http-acceptance.test.ts:34`. Zero imports inside `src/`. |

### Dead exported symbols
`auth-rate-limit.recordPairingSuccess`; `cache.ssaVaryHeader`; `discovery.ts` (4 status enums);
`entitlements.PRINT_QUOTA_UNIT`; `job-delivery.CLAIM_LEASE_SECONDS`;
`job-status.isExpiredLateSuccessAllowed`; `lifecycle.PRINTER_LIFECYCLES` and
`lifecycle.assertLifecycleTransition`; `limit-signal.LIMIT_SIGNAL_ENTITLEMENTS`;
`manager-auth.cleanupExpiredManagerSessions` and `manager-auth.getAuthenticatedUserClaims`;
`platform-auth.getPlatformCookieName`;
`ws-rate-limit.isWsUpgradeLocallyLocked`;
`correlation.ensureRequestId` / `extractRequestIdFromHeaders` / `getRequestId`;
`request-guard.getReserved*`;
`ws.__clearWsBucketsForTests`, `ws.__pruneIdleWsBucketsForTests`, `ws.publishAgentSessionClose`,
`ws.publishTenantSessionClose`.

### Dead schema
`print_job_rate_limits` — see DEFECT-PG-02.

### Stale tracked artifacts
* **DEFECT-DEAD-01 (medium, repository hygiene).** `fix.patch` (963 lines, 27 files) and
  `final-fix.patch` (9 712 lines, 30 files) are **tracked in git at HEAD** and describe the removed
  SQLite-Gateway architecture. Verified stale: the hunks they contain are already present in the
  working tree (e.g. `agent/cmd/cli/main.go:183` already has the fail-closed `config.Ensure`, and
  `agent/internal/queue/queue.go:124-131` already has the terminal-status `claim_token` clearing).
  `docs/CORRECTNESS_REVIEW.md` §3.1 already recommends deleting them; they are still there.

### Not dead (verified, to avoid false positives)
`correlation` (15 referencing files), `request-guard` (6), `trusted-proxy` (2) are all live.

---

## 13. Duplication — **COMPLETED (repository-wide)**

| Concept | Copies | Verdict |
|---|---|---|
| “Subscription is live” SQL predicate | 13 sites (§2 DEFECT-GW-03) | **Duplicated.** Substance identical today; `now()` vs `clock_timestamp()` differs; 13 coordinated edits needed for any change. |
| “Unassigned job” filter (`NOT IN` subqueries) | 2 (`api/jobs/route.ts` fenced, `actions.ts` unfenced) | **Divergent duplicate** — DEFECT-GW-01. |
| Physical-outcome marker list | `src/lib/job-status.ts` (`PHYSICAL_OUTCOME_UNKNOWN_MARKERS`), `src/shared/job-vocabulary.ts` (`UNKNOWN_OUTCOME_MARKERS`), `src/desktop/lib/printers.ts` (regex), Odoo `_GATEWAY_UNKNOWN_MARKERS` | **Duplicated by design**, locked together by unit tests (`physical-outcome.test.ts`, `odoo-addon-static.test.ts`). Acceptable, documented. |
| Branch→agent authorization (Odoo) | 3 call sites → 1 helper `RuntimeAgentAssignment.assigned_agent_ids` | **Not duplicated** — correctly funneled. |
| Virtual/software printer classification | Go `IsProductionPrinter`/`ClassifyDeviceInfo`, Gateway `printer-virtual.ts`, desktop `isVirtualPrinter` | **Duplicated by design**: the Go classifier is authoritative (“DEFENSIVE FILTER ONLY” comments in both consumers). |
| Printer desired-state PATCH | Desktop `updateGatewayPrinter` (manager transport) vs `gateway_agent_request` allowlist (excludes PATCH) | **Not duplicated** — one path, agent path deliberately forbidden. |
| Status vocabulary | 1 shared module + Odoo mirror | **Not duplicated** in TS. |

---

## 14. Source of truth — **COMPLETED**

| Fact | Owner | Verified |
|---|---|---|
| Job status + physical outcome | Gateway (`print_jobs` + `derivePhysicalOutcome`) | Yes — Odoo and both UIs mirror it and never invent. |
| Print job idempotency (event-driven) | Odoo `print_gateway.intent.intent_key` | Yes — `UNIQUE(intent_key)`, fenced claim tokens. |
| Print job idempotency (API) | Gateway `Idempotency-Key` + `createPrintJobForPrinter` reuse | Yes. |
| Duplicate-print barrier on the machine | Agent SQLite ledger (`queue.BeginPrint`, `ErrTerminalState`) | Yes. |
| Company/branch scope & policy | Odoo (`res.company`, `print_gateway.policy`, `runtime_agent_assignment`) | Yes. |
| Agent/printer identity & lifecycle | Gateway (`agents`, `printers`, `lifecycle_revision`) | Yes. |
| Desired printer configuration | Gateway (`desiredRevision` / `appliedDesiredRevision` / `observedDesiredRevision`); agent refuses to execute until all three agree | Yes (`desired_state.go`). |
| Entitlements / quotas | Gateway (`tenant_subscriptions` + `plans.entitlements` + `print_usage_periods`) | Yes — Odoo treats 429 as a billing limit, never as a local decision. |
| Clock | Database clock via `src/lib/database-clock.ts` (Gateway) and `db_now_utc` (Odoo) | Yes — **except** the 4 host-clock sites in DEFECT-GW-02. |
| Manager session token | Rust process memory (`MANAGER_SESSION` `OnceLock<Mutex<..>>`), stripped from the login response before it reaches the renderer | Yes (`src-tauri/src/commands.rs`). |

**Source-of-truth violations found:** DEFECT-GW-01 (a second, divergent copy of a filter),
DEFECT-GW-02 (host clock competing with the database clock), DEFECT-GW-03 (13 copies of the
entitlement gate).

---

## 15. Dependency graph — **COMPLETED**

```
Odoo addon
  └─(HTTPS, outbound only)→ Gateway  /api/print/jobs, /api/print/jobs/batch-status,
                                     /api/odoo/configuration, /api/odoo/agents,
                                     /api/odoo/printers, /api/odoo/health
Gateway (Next.js)
  ├─→ PostgreSQL (single authority; LISTEN/NOTIFY, advisory locks, clock_timestamp)
  ├─→ Stripe (checkout, portal, webhook)
  ├─(WSS, outbound from agent)→ Go Agent
  └─(HTTPS)← Web console (server actions + /api/**)
Go Agent (Windows)
  ├─→ Gateway (WSS job stream, HTTPS heartbeat/register/discovery/poll-claim)
  ├─→ SQLite ledger (local, duplicate-print barrier)
  └─→ printers (spooler / USB / TCP 9100 / IPP / IPPS)
Tauri desktop manager (Windows)
  ├─(Rust IPC)→ bundled yasser-agent-cli.exe (pair, gateway-request, get-printers,
  │                                           discover, test-printer, register)
  ├─(Rust reqwest)→ Gateway  /api/auth/manager/*, /api/health, PATCH /api/printers/{id}
  └─(Rust)→ Windows SCM (sc.exe / net.exe / taskkill.exe, all via System32)
```

**Cycles:** none. Odoo never talks to the agent; the desktop never talks to PostgreSQL; the agent
never talks to Odoo. Every edge is outbound-only from the customer side.

**Confirmed correct:** the desktop uses the **manager** Rust transport for printer desired-state
PATCH and the **agent** Rust transport (strict allowlist, PATCH forbidden) for printer discovery and
creation — matching the comment in `commands.rs` “Printer desired-state mutation is manager-only at
the HTTP boundary, so an Agent bearer must never be able to reach PATCH.”

---

## 16. Security — **COMPLETED**

### Verified controls
* **Tenant isolation:** every tenant-owned table carries a composite `(tenant_id, id)` unique index;
  every query is fenced; `leftJoin` in `GET /api/printers` re-fences the joined `agents` row on
  `tenantId`. `tests/tenant-isolation.test.ts` passes.
* **SSRF:** printer destinations must be private/link-local, metadata IPs explicitly blocked, no
  credentials, no query/fragment, protocol-specific port allowlists (Gateway **and** re-validated in
  the agent’s `desired_state.go`).
* **Desktop IPC boundary:** renderer cannot supply `Authorization`, `Cookie`, `Host`,
  `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `X-Forwarded-*`, `X-Real-IP`;
  64 KiB header budget, 8 MiB body cap, 8 MiB streaming response cap (enforced while reading, not
  after), `redirect::Policy::none()`, 5 s connect / 10 s total timeout;
  origin pinning (scheme + host + port must equal the configured origin), `..` and `\` rejected;
  logins strip `accessToken` before the renderer sees it; 401/403 clears the session.
* **Agent console allowlist** (`allowed_agent_gateway_path`): GET `/api/printers`, `/api/agents`,
  `/api/jobs?{limit,offset,status,search,q,printerId,agentId}` (values ≤200 chars);
  POST `/api/printers`, `/api/printers/{id}/test-connection`, `/api/printers/{id}/test-print`
  (id charset allowlisted); everything else — including all PATCH — rejected.
* **Admin-safe process control:** `system32_exe` name validation, PID ownership record with image
  path + creation-time re-verification, no kill-by-image-name.
* **Secrets:** DPAPI-protected agent secret; 0700 + hardened ACLs on agent data and logs; no
  credential fallbacks; claim tokens redacted in job timelines (`claim-token-redaction.test.ts`).
* **Odoo:** `ir.model.access.csv` + `ir.rule` company isolation + `check_access("read")` before any
  payload leaves Odoo + `base.group_system` on all runtime controllers + AES-GCM secret storage.
* **Rate limiting & DoS:** auth rate limits, WS token buckets and socket cap, request size limits,
  `MAX_PRINTERS_LIST`/`MAX_PRINTERS_OFFSET`, bounded discovery scans, bounded child-process output.
* **CSRF/origin** checks on browser-facing routes.

### Confirmed security-relevant defects
* None that grant access. DEFECT-GW-01 is a **performance** defect, explicitly not a data leak
  (the outer row is tenant-fenced and IDs are globally unique).
* The one gap worth flagging is procedural: **DEFECT-DEAD-01** ships 10 675 lines of diff describing
  the *old* architecture (including the removed SQLite-Gateway design) in the published repository.

### Unresolved questions
* No CVE scan possible (§11).

---

## 17. Error handling — **COMPLETED**

* **Fail-closed everywhere it matters:** unknown physical outcome ⇒ `unknown` + no retry + no
  failover; missing delivery evidence ⇒ terminal `failed` with `UNKNOWN_PARTIAL_DELIVERY`;
  missing/invalid agent config ⇒ agent idles “Unpaired” rather than exiting (avoids SCM 1053);
  desktop directory creation failure ⇒ explicit admin message, operations refuse.
* **Error classification is explicit:** `MarkUnknown` / `preDispatchIRErr` /
  `_is_pre_dispatch_error` / `HasUnknownOutcomeMarker` form a single vocabulary across Go, Gateway
  TS and Odoo Python.
* **Error rewriting is guarded:** `friendlyPrinterError` refuses to reword any unknown-outcome
  marker and strips filesystem paths, panics and stack backtraces.
* **Never break the business transaction:** Odoo policy scheduling and Gateway dispatch errors are
  caught per-item; `action_post`, `_action_done`, `_process_saved_order` can never fail because of
  printing.
* **Bounded retries:** intents `max_attempts = 3` with exponential backoff
  (`min(300, 15 * 2**(attempt-1))`) and a cron recovery path; Gateway `MAX_RETRIES = 5`,
  `MAX_DELIVERY_ATTEMPTS = 5`; Odoo failover bounded (depth 3, visited set, protocol/capability
  parity, first attempt only).

### Confirmed defects
* Logging-only failure: `dashboard-client.tsx` job filter failure is `console.error` only — no user
  surface (minor, UX).
* `src/app/actions.ts:296-299` `catch (error) { if (error instanceof ActionError) throw error; throw error; }`
  — both branches are identical; the `catch` is a no-op (dead error handling).

---

## 18. State machines — **COMPLETED**

| Machine | States | Where enforced | Terminal | Notes |
|---|---|---|---|---|
| `print_jobs.status` | queued, claimed, printing, success, failed, expired | `src/lib/job-status.ts` transition table + SQL predicates | success, failed, expired | Closed enum in `schema.ts`; illegal transitions rejected by UPDATE rowcount 0. |
| Physical outcome | printed / not_printed / unknown / unproven | `derivePhysicalOutcome` + markers | — | `success` ⇒ `unknown` by design. |
| `agents.lifecycle` | active, disabled, retired | `agent-lifecycle.ts` (`transitionAgentLifecycle`) + `canTransitionLifecycle` | retired | Advisory lock + `FOR UPDATE`; lifecycle revision bumped; audit written in the same tx. |
| `printers.lifecycle` | active, disabled, retired | `actions.setPrinterLifecycle`, `PATCH /api/printers/[id]` | retired | Lock order: agent row → printer row (documented to avoid heartbeat deadlock). |
| Printer desired config | desiredRevision → appliedDesiredRevision → observedDesiredRevision | `agent/internal/agent/desired_state.go` | — | Agent refuses execution unless applied ≥ desired and observed ≥ desired; restart recovery requires a **fresh** physical observation (`desired_state_test.go:290`). |
| Odoo `print_job.status` | outbox matrix | `print_job.py._advance_status` | yes | Submission lease + pre-dispatch proof gate failover. |
| Odoo `intent.status` | pending, claimed, dispatched, skipped, failed | `print_intent.py.write` | dispatched, skipped | `claimed → pending` requires claim token or `allow_lease_recovery`. |
| Desktop autostart | unset → chosen(default-on) → explicit | `main.rs::apply_first_launch_autostart` + `record_autostart_choice` | — | Marker written **only** after a successful OS change (4 unit tests lock this); marker failure rolls the OS change back. |
| Agent pairing | unpaired → paired | Gateway pairing code hash + expiry; CLI writes config | — | Pairing code never echoed back from the CLI (documented contract). |

**Confirmed defects:** none. All machines are closed, and every mutation is guarded by either an
SQL predicate or a row-level lock.

**Noted:** `src/app/actions.ts:296-299` no-op `catch` (see §17).

---

## 19. Scalability — **COMPLETED**

### Bounded
`maxConcurrentJobs 8`, `maxPendingJobs 64`, `maxPendingJobsPerPrinter 8`, `maxClaimBatch 20`,
heartbeat page 500, heartbeat probes ≤64 concurrent, dashboard job list `limit: 100`,
printer list ≤1000 / offset ≤10 000, WS socket cap + token buckets, discovery scans
(≤254 LPR targets, ≤100 SNMP targets, 16 workers, 4-10 s sub-contexts), child-process output
caps, 8 MiB request/response caps, 64 KiB header budget, Odoo intent batch 50 with
`_commit_progress` time-budgeting.

### Indexed / fenced
Composite `(tenant_id, id)` indexes on every tenant table; `FOR UPDATE … SKIP LOCKED` on claim;
`pg_advisory_xact_lock` for enqueue and lifecycle transitions; PG `LISTEN/NOTIFY` instead of
polling for delivery.

### Confirmed defects
* **DEFECT-GW-01** — the dashboard server action performs a **cross-tenant full scan** of
  `printers` and `agents` on every poll (every 6 s per open dashboard, 3 s while pairing). This is
  the single clearest scalability defect: cost grows with (tenants × printers) × (dashboards ×
  poll rate), which is quadratic in fleet size.
* **DEFECT-GW-03** — 13 copies of the entitlement `EXISTS` predicate means 13 correlated subqueries
  per claim statement in the worst case (4 of them are in `agent/jobs/route.ts` alone, evaluated
  three times in one statement: candidate CTE, queued CTE, claimable CTE, and again in the final
  UPDATE).

### Unresolved questions
* Actual query plans and throughput under load are **RUNTIME-ONLY UNOBSERVABLE** (no PG server).

---

## 20. External documentation verification — **COMPLETED**

Gate rule: retry multiple authoritative sources before any MATCH / DIVERGENCE / DEFECT
classification.

### Verified against Odoo 19 primary sources

| Claim in this codebase | Source 1 | Source 2 | Verdict |
|---|---|---|---|
| `models.Constraint("…", "…")` is the Odoo 19 replacement for `_sql_constraints` | [ORM API — Odoo 19.0 documentation](https://www.odoo.com/documentation/19.0/developer/reference/backend/orm.html) — “you can declare Constraint, Index and UniqueIndex” | [Odoo 19 core source `odoo/addons/base/models/ir_cron.py`](https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/addons/base/models/ir_cron.py) uses `_check_strictly_positive_interval = models.Constraint('CHECK(interval_number > 0)', …)` | **MATCH** |
| `@api.private` exists in Odoo 19 and marks a method non-RPC-callable | Odoo 19 ORM docs, “Method decorators”: `odoo.api.private(*method)` | Used throughout `print_intent.py` / `runtime_assignment.py` | **MATCH** |
| `cr.postcommit` is a `Callbacks()` object with `.add()` on the Odoo cursor | [Odoo 19 `odoo/sql_db.py`](https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/sql_db.py) — `BaseCursor.__init__`: `self.precommit = Callbacks(); self.postcommit = Callbacks(); …` | rco-odoo, [odoo/odoo PR #62031](https://github.com/odoo/odoo/pull/62031): “moving the subsequent action into a post-commit hook (`cr.postcommit.add()`)” | **MATCH** |
| “Odoo 19 resolves `env.company` from `allowed_company_ids[0]` (Environment has no `with_company`)” | [Odoo 19 `odoo/orm/environments.py`](https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/orm/environments.py) — `Environment` exposes only `__call__(cr, user, context, su)`; no `with_company`; `company` is a `cached_property` that “If not specified in the context (`allowed_company_ids`), fallback on curr…” | `print_intent.py` uses `new_env(context=dict(new_env.context, allowed_company_ids=[record_company.id]))` | **MATCH** (nuance: `with_company` exists on `BaseModel`, not on `Environment`; the comment is accurate as written and the code is valid either way) |
| `ir.cron._commit_progress(processed, *, remaining, deactivate) -> float` returns **remaining seconds** and commits | [Odoo 19 `ir_cron.py`](https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/addons/base/models/ir_cron.py) chunk 4 — full signature and docstring, `:return: remaining time (seconds) for the cron run` | Same file chunk 2 — `_process_job` docstring: “The server action can use the progress API via the method `:meth:_commit_progress`” | **MATCH** — `print_intent.cron_recover_pending_intents` uses `cron._commit_progress(remaining=len(candidates))` then `cron._commit_progress(1)` and compares the result to `<= 0`. Both calls are correct against the real signature. |
| `odoo.tools.safe_eval.safe_eval` exists in Odoo 19 | [Odoo 19 `odoo/tools/safe_eval.py`](https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/tools/safe_eval.py) — `__all__ = ['const_eval', 'safe_eval']`, with opcode blacklists | Used in `print_policy.py` for domain filters | **MATCH** |

### Not verified
* **`models.UniqueIndex("(cols) WHERE predicate")`** — the existence of `UniqueIndex` is confirmed by
  the official docs, but I could not reach an authoritative page or source line attesting the
  partial-index (`WHERE`) form in Odoo 19. `runtime_assignment.py` uses it once. Classified
  **UNVERIFIED**, not MATCH and not DEFECT.
* **CVE status of pinned dependency versions** — no vulnerability database reachable.
  Classified **NOT PERFORMED**, not a clean result.

---

## 21. Second-pass bypass search (per-defect)

For each defect above, every alternate mutation path was searched for a surviving old behaviour.

**DEFECT-GW-01 (unfenced “unassigned” subquery).** Alternate paths searched:
`src/app/api/jobs/route.ts` (fenced ✅), `src/app/actions.ts::getDashboardState` (no unassigned
filter — KPI only ✅), `src/app/actions.ts::getDashboardJobs` (**unfenced ❌ — the defect**),
`src/lib/job-delivery.ts` (claim SQL, no unassigned filter ✅),
`src/app/api/print/jobs/batch-status` (status by id ✅), desktop `fetchGatewayJobs`
(`valid_jobs_query` allowlist, server-side only ✅).
**Result: one surviving path.** No other.

**DEFECT-GW-02 (host clock).** All `updatedAt:` writes in `src/` enumerated (38 sites):
35 use `sql\`now()\`` or `sql\`clock_timestamp()\``, **4 use `new Date()`**
(`actions.ts:276`, `settings/route.ts:28`, `onboarding/route.ts:53` and `:59`), and the rest are
read projections. No other host-clock timestamp reaches a persisted audit/ordering column.
**Result: four surviving sites, all enumerated.**

**DEFECT-GW-03 (entitlement gate duplication).** 13 sites enumerated and compared field by field;
all include `status IN ('trialing','active','past_due')`, the `past_due`-conditional
`current_period_end` check, and `COALESCE(entitlement_blocked,false) = false`. **No site omits a
condition** ⇒ no bypass exists today; the defect is duplication + `now()`/`clock_timestamp()`
divergence only.

**DEFECT-UI-01 (reprint bypasses `busy`).** Alternate reprint paths searched:
`POST /api/jobs/[id]/reprint` (requires terminal job + `jobs.retry` permission ✅);
`src/app/actions.ts::reprintJob` (not called from the dashboard client — the dashboard uses the
route ✅); Odoo `action_reprint` (separate surface, requires terminal Gateway state ✅);
agent-side reprint (only under opt-in `reprint_after_crash` ✅).
**Result: the missing `busy` guard is the only gap; the server-side guard is intact in all paths.**

**Duplicate-print sweep (all transports).** Enumerated in §7: WebSocket push, HTTP poll-claim,
retry, requeue, stale-claim reclaim, stale-printing sweep, admin reprint, Odoo failover, Odoo
re-arm, agent crash recovery, `reprint_after_crash`, direct SQL (not reachable from any code path —
all mutations go through the service layer).
**Result: no transport can produce a second physical print automatically.** The only ways to print
twice are (a) the operator’s explicit reprint dialog, and (b) the opt-in `reprint_after_crash`
setting — both intentional, both warned.

---

## 22. Changed-concept sweep (repository-wide)

| Removed concept | Searched | Surviving references | Verdict |
|---|---|---|---|
| `branches` / `destinations` / `local_networks` / `document_types` / `printer_bindings` tables | `src/`, `odoo_addons/`, `agent/`, `drizzle/` | Only in historical migrations `0006/0011/0020/0021/0028` (the DROP statements) | **Clean** |
| `branch_id` / `branchId` as a Gateway column | `src/` | One defensive **rejection** guard in `src/app/api/printers/[id]/route.ts:62` | **Clean** (the guard proves the concept is gone) |
| Odoo “branch” | `odoo_addons/` | `res.company` child-company semantics only (`runtime_printers._scope`, `policy.branch_id`, `runtime_assignment.branch_id`); migration `1.1.0/pre-migrate.py:122` drops the old `print_gateway_printer.branch_id` column | **Clean** — “branch” is now a company, not a removed column |
| SQLite-as-Gateway-architecture | whole repo | Only in the two stale patches (DEFECT-DEAD-01) and in `docs/CORRECTNESS_REVIEW.md` prose | **Fails** on the patches |
| Tenant-fenced subquery fix | `src/` | `api/jobs/route.ts` fixed, `actions.ts` not | **Fails** (DEFECT-GW-01) |
| Database-clock discipline | `src/` | 4 host-clock writes remain | **Fails** (DEFECT-GW-02) |
| Odoo `completed_at` DB-clock fix | `odoo_addons/` | All 20 writes use `db_now_utc` | **Clean** (but the doc was not updated — DEFECT-ODOO-01) |
| Printer desired-state PATCH is manager-only | `src-tauri/`, `src/desktop/` | Agent allowlist excludes PATCH by construction + 4 unit tests | **Clean** |
| Autostart default-on-every-launch bug | `src-tauri/src/main.rs` | Marker written only on success; 4 unit tests | **Clean** |

---

## 23. Defect register

| ID | Subsystem | Severity | Status | Summary |
|---|---|---|---|---|
| DEFECT-GW-01 | Gateway / Scalability | **Medium** | Confirmed | `actions.getDashboardJobs` “unassigned” filter uses untenant-fenced `NOT IN` subqueries — the pre-fix form that `api/jobs/route.ts` already fixed. Cross-tenant full scan on every dashboard poll. |
| DEFECT-GW-02 | Gateway / Configuration | Low | Confirmed | 4 write sites stamp `updated_at` with the host clock (`new Date()`) against the codebase-wide database-clock discipline, including `setPrinterLifecycle` which contradicts the PATCH route for the same row. |
| DEFECT-GW-03 | Gateway / Duplication | Low | Confirmed | Subscription-liveness predicate inlined at 13 SQL sites; `requireTenantBillingAccess` uses `clock_timestamp()` while the other 12 use `now()`. No bypass today; high change-risk. |
| DEFECT-GW-04 | Gateway | Informational | Confirmed (documented) | `agents/service-status` returns a hardcoded `blocked: true` payload. |
| DEFECT-UI-01 | UI | Medium-low | Confirmed | Reprint confirmation never sets `busy`: no in-flight disable, no spinner, and the drawer’s Reprint button stays clickable during the request. The one action that intentionally creates a duplicate print lacks the guard every other mutation has. |
| DEFECT-UI-02 | UI | Low | Confirmed | `settings/page.tsx` “Security” tab renders two titled boxes with no content. |
| DEFECT-PG-01 | PostgreSQL | Low | Confirmed | `drizzle/meta/` has only snapshots 0000 and 0028, so `db:generate` emits the whole 0028→HEAD delta as one migration. `db:migrate` unaffected. |
| DEFECT-PG-02 | PostgreSQL / Dead code | Low | Confirmed | `print_job_rate_limits` table has zero readers and zero writers. |
| DEFECT-DEAD-01 | Dead code | Medium | Confirmed | `fix.patch` (963 lines) and `final-fix.patch` (9 712 lines) are tracked at HEAD and describe the removed SQLite-Gateway architecture; all their hunks are already applied. Prior review already recommended deletion. |
| DEFECT-ODOO-01 | Odoo / Documentation | Low | Confirmed | `docs/CORRECTNESS_REVIEW.md` §3.3 still recommends fixing `completed_at` host-clock use; all 20 writes already use `db_now_utc`. Stale doc. |
| DEFECT-DEP-01 | Dependencies | Low | Confirmed (open) | `mattn/go-sqlite3` requires cgo (prior review §3.5, still open). |
| — | Error handling | Informational | Confirmed | `src/app/actions.ts:296-299` — `catch` whose two branches both `throw error` (no-op). |

**No defect in this register grants unauthorized access, leaks tenant data, or can cause an
automatic duplicate print.**

### Not classified as defects (recorded so they are not re-raised)
* `agents/service-status` hardcoded payload — documented, intentional.
* `past_due` bypassing `current_period_end` — deliberate product policy.
* `agentLiveView(agent)` called without `nowMs` while `kpis` passes it — both resolve to a fresh
  timestamp on every render because of the 5 s ticker; no divergence possible.
* `dispatch_test.go` being tracked in git — it is a real Go test file, not a stray artifact.

---

## 24. Completion statement

All twenty subsystems above carry an explicit completed result with files inspected, entry points,
important functions, data flow, state transitions, authorization boundaries, source of truth,
duplicate-implementation search, dead-code candidates, external dependencies, confirmed defects,
confirmed correct behaviour, and unresolved questions.

**No subsystem is marked PARTIAL REVIEW.** Where a conclusion could not be reached from source
alone, it is recorded under *Unresolved questions* and tagged **RUNTIME-ONLY UNOBSERVABLE** with
the specific missing capability (Go toolchain, PostgreSQL server, Node ≥24, CVE database, or the
`UniqueIndex ... WHERE` documentation form). Those five gaps were never used to avoid reading
source: the Go Agent (25 027 LOC), the Windows integration, and all printer transports were
reviewed line-by-line by hand precisely because the Go toolchain is unavailable.
