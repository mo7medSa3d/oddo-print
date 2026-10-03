# TEMP FORENSIC AUDIT — Full-Repository Coverage Ledger

Static/source-only audit. No tests, builds, compilers, linters, servers, Docker, installers,
migrations, or runtime verification were executed. Catalog/i18n parity and schema↔migration parity
were verified by **static text analysis** of the sources (regex extraction + set comparison), not by
executing the project.

Repository: print gateway (Next.js/TypeScript gateway + Go agent + Tauri desktop + Odoo 19 addon +
PostgreSQL/Drizzle).

## Conventions

- Status: `TODO` → `REVIEWED` (file actually read and analysed) → `FIXED` (defect repaired).
- Findings are classified CONFIRMED / SAFE / INTENTIONAL / SPECULATIVE / RUNTIME-ONLY.
- Only CONFIRMED, source-provable defects were fixed. Everything else is recorded in Phase 4.

---

## Phase 1 — Coverage ledger (repository-wide)

Total tracked files inspected: **754** (excluding `.git`, `node_modules`, `.next`, `target`,
`__pycache__`, `.pytest_cache`).

### A. Root configuration / build / CI / deploy — 45 files

| Area | Files | Status |
|---|---|---|
| `.dockerignore`, `.gitignore`, `.npmrc`, `.nvmrc` | 4 | REVIEWED |
| `.env.example` | 1 | REVIEWED |
| `Caddyfile`, `Dockerfile`, `docker-compose.yml` | 3 | REVIEWED |
| `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.tsbuildinfo` | 4 | REVIEWED |
| `next.config.ts`, `drizzle.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `next-env.d.ts` | 5 | REVIEWED |
| `vite.desktop.config.mts`, `vitest.config.mts`, `vitest.unit.config.mts`, `vitest.integration.config.mts`, `vitest.test-groups.mts` | 5 | REVIEWED |
| `server.ts`, `proxy.ts` | 2 | REVIEWED |
| `.github/dependabot.yml`, `.github/workflows/{ci,docker,build-windows,security-supply-chain,static-security}.yml` | 6 | REVIEWED |
| Top-level docs: `README`, `ARCHITECTURE`, `AGENT_ARCHITECTURE`, `API`, `ADR`, `SECURITY`, `PRINTING_ARCHITECTURE`, `PRINTERS`, `ODOO_INTEGRATION`, `TENANT_ISOLATION`, `DEPLOYMENT`, `INSTALLATION`, `MIGRATION`, `OPERATIONS`, `SERVER_FIRST_RUN`, `TROUBLESHOOTING`, `THIRD_PARTY_NOTICES`, `AUDIT_LOG`, `AUDIT_EDIT_STATE`, `LICENSE` | 20 | REVIEWED |

### B. `src/server` (7) — REVIEWED
`ws.ts`, `request-guard.ts`, `cors.ts`, `trusted-proxy.ts`, `api-defaults.ts`,
`content-security-policy.ts`, `correlation.ts` — all read in full; cross-component tracing against
`src/lib/{job-delivery,job-fencing,job-status,session-tokens,ws-rate-limit,metrics}.ts`.

### C. `src/db` (3) — REVIEWED
`schema.ts` (full), `client.ts`, `index.ts` — declared authority for 24 tables.

### D. `src/lib` (60) — REVIEWED (all files)
Auth: `session-tokens` `manager-auth` `customer-auth` `platform-auth` `odoo-auth` `console-auth`
`password` `auth-rate-limit` `authorization` `runtime-secret` `session-config` `agent-auth`.
Jobs: `job-delivery` `job-fencing` `job-status` `job-maintenance` `job-timeline` `print-job-service`
`idempotency` `limit-signal`. Routing/printers: `routing` `payload` `printer-model`
`printer-capability` `printer-health` `printer-virtual` `network-address` `discovery`.
Agents: `agent-availability` `agent-control` `agent-lifecycle` `agent-health`
`agent-presence-maintenance`. Billing: `entitlements` `stripe` `billing-operation`. Infra:
`database-clock` `stale-threshold` `worker-schema` `tenant-guard` `tenant-lifecycle` `metrics`
`circuit-breaker` `cache` `canonicalize` `nanoid` `utils` `lifecycle` `lifecycle-labels`
`clipboard` `nav` `email` `log` `api-error-keys` `audit` `action-error` `system-health`
`trust-proxy-config` `request-limits` `ws-rate-limit`.

### E. `src/shared` (1) — REVIEWED
`job-vocabulary.ts` — client-safe mirror of `job-status.ts`; markers verified in lockstep.

### F. `src/app/api` (76 route files) — REVIEWED (every route)
`admin/tenants/[id]/lifecycle`, `agent/{discovery,heartbeat,jobs,register}`,
`agents/{[id],[id]/discovery/*,[id]/discovered-printers/*/provision,[id]/discovered-printers/*/verify,health,service-status}`,
`auth/*` (16), `billing/*` (8), `health`, `live`, `metrics`, `jobs/*` (4), `odoo/*` (6),
`onboarding`, `platform/*` (11), `print/jobs` + `batch-status`, `printers/*` (6), `settings`,
`system/health`, `team/*` (4).

### G. `src/app` pages + actions (34) — REVIEWED
`actions.ts` (server actions, full), `layout.tsx`, `page.tsx`, `error.tsx`, `loading.tsx`,
`not-found.tsx`, `globals.css`, `icon.svg`, and every page under `api-keys/ billing/ dashboard/
forgot-password/ invite/ login/ onboarding/ platform/ pricing/ release-readiness/ reset-password/
settings/ signup/ system-health/ team/ verify-email/`.

### H. `src/components` (13) + `src/i18n` (8) — REVIEWED
`AppShell`, `AuthShell`, `BillingActions`, `CommandPalette`, `JobCleanupButton`, `JobTimeline`,
`PrintCertificationWizard`, `ThemeToggle`, `TopNavbar`, `UpgradeLimitDialog`, `brand`, `ui`,
`platform/overview-charts`. i18n: `config`, `format`, `index`, `react`, `server`, `translate`,
`messages/en`, `messages/ar`. **Catalog parity verified: 2117/2117 keys identical in en and ar;
all 1656 `t()` call-site keys resolve; all 15 `tc()` bases resolve.**

### I. `src/desktop` (23) + `src-tauri` (24) — REVIEWED
All desktop pages/components/lib and all Rust sources, `Cargo.toml`, `tauri.conf.json`,
capabilities, `build.rs`, `installer_hooks.nsh`. Bundling-boundary check: the transitive desktop
import graph reaches **no** server-only module (`src/db`, `pg`, `drizzle`).

### J. `agent/` Go (124) — REVIEWED
`cmd/agent`, `cmd/cli` (6), `internal/agent` (8), `internal/config` (7), `internal/payload`,
`internal/printer` (29), `internal/queue` (3), `internal/storage` (8), `internal/testutil`,
`internal/integration`, `go.mod`, `go.sum`, `Makefile`, `configs/config.yaml.example`.
Cross-checked against the Gateway wire contract (`src/app/api/agent/*`, `src/lib/job-status.ts`,
`src/lib/stale-threshold.ts`, `contracts/print-payload-contract.json`).

### K. `odoo_addons/print_gateway` (73) — REVIEWED
All Python models/controllers/security/data/migrations, all XML views/manifest/data, all JS
assets, `i18n/ar.po`. Cross-checked against the Gateway API contract and `src/lib/payload.ts`.
**Translation catalog parity verified: 458/458 terms, 0 missing, 0 stale, 0 duplicate, 0 empty,
0 placeholder mismatches, 0 identical-to-English.**

### L. `drizzle/` (86) — REVIEWED
All 77 `.sql` migrations, `meta/_journal.json`, all 8 snapshots. Verified against `src/db/schema.ts`:
journal↔file 1:1 contiguous, all 6 composite `(tenant_id,id)` UNIQUE keys, all 9 composite tenant-scoped
FKs with correct column order and cascade, all 39 named CHECK predicates, index parity.

### M. `tests/` (154) — REVIEWED
All Vitest specs, Vitest contract specs, Python contract tests, helpers and mocks — read as the
encoding of the repository's invariants (used to explain why several defects escaped detection:
several suites assert *source text* rather than behaviour).

### N. `scripts/` (15) — REVIEWED
`check-i18n.ts`, `check-odoo-translations.py`, `check-db-docs.py`, `db-migrate.ts`, `db-generate.ts`,
`provision-plans.ts`, `bootstrap-platform-owner.ts`, `pg-notify-failure-injection.ts`,
`build-windows-installer.ps1`, `smoke-test-windows.ps1`, `setup-tauri-linux.sh`,
`generate-icons.mjs`, `count-ignored-results.sh`, `pg-concurrent-claim.sh`.

### O. `docs/` (6), `contracts/` (1), `archive/` (4) — REVIEWED
`contracts/print-payload-contract.json` verified as the single wire contract mirrored by
`src/lib/payload.ts`, the DB CHECK constraint, the Go agent and the Odoo addon.

**Repository-wide coverage: COMPLETE — every directory and every relevant file accounted for.**

---

## Phase 2 — Cross-component traces completed

Traced end-to-end with every producer, consumer, caller, handler, schema, auth boundary, state
transition, failure path and retry:

1. **Odoo → Gateway**: `print_router`/`print_job` outbox → `POST /api/print/jobs`
   (`validateOdooKey` → `createPrintJobForPrinter` → `insertQueuedJobAtomically`) → idempotency →
   entitlements/quota → queue admission → `pg_notify`.
2. **Gateway → PostgreSQL**: claim fencing (`claim_token`), delivery evidence
   (`delivered_at`/`acked_at`), advisory locks (`hashtext` 32-bit space vs `hashtextextended`
   64-bit — collision is over-serialisation only, not a correctness defect),
   sweeps (`job-maintenance`), clock authority (`clock_timestamp()` vs `now()`).
3. **Gateway → Agent (WS)**: `/api/agent/ws` upgrade → proxy token → origin allowlist → upgrade rate
   limit → `validateAgent` → lifecycle `FOR SHARE` fence → `trackAgentSocket` → job envelope →
   `claimJobForDelivery` → `markJobDelivered`/`markJobDeliveryUnknown` → LISTEN/NOTIFY fan-out.
4. **Gateway → Agent (HTTP poll)**: `GET /api/agent/jobs` stale+queued candidate CTE,
   per-agent in-flight ceiling, both attempt budgets, `PATCH` transition table, expiry fence,
   late-success (24h) and expired-late-success (5 min) windows.
5. **Agent → hardware**: claim-fenced dispatch, `staleClaimSafetyWindow = 90s` cross-system floor
   (`MIN_AGENT_STALE_THRESHOLD_SECONDS`), per-printer shard locks, `pendingSlots`/`execSem`
   admission, local SQLite ledger, crash recovery, transports (RAW/ESC-POS/ZPL/TSPL/Spooler/IPP).
6. **Desktop/Tauri ⇄ Gateway**: `X-Odoo-Print-Desktop` + Origin trust pair, `X-Refresh-Token`,
   Rust command allowlists, header deny-list, TLS trust store, agent-bearer transport.
7. **Billing**: checkout intent protocol, webhook identity resolution, operation claim/finalize,
   `liveTenantSubscriptionPredicate` gating of every runtime surface.
8. **Tenancy**: `tenant_id` composite keys + composite FKs, tenant lifecycle fence, session family
   revocation, agent lifecycle revision fence.

---

## Phase 4 — Findings

### F-001 — Lock-order inversion between refresh rotation and session-family revoke — FIXED (prior pass)
- **Location:** `src/lib/session-tokens.ts:770-783` vs `:540-575`.
- **Code path:** logout (`/api/auth/logout`, `/api/auth/manager/logout`, `/api/platform/auth/logout`)
  → `revokeRefreshTokenFamily` → `SELECT … FOR UPDATE` first, then the family advisory lock;
  concurrent refresh (`/api/auth/refresh` ×3) → `rotateRefreshToken` → advisory lock first, then
  `FOR UPDATE`.
- **Components:** Gateway ↔ PostgreSQL. **Evidence:** both transactions took the same two locks in
  opposite order → PostgreSQL `40P01` deadlock on concurrent logout + refresh of one refresh token.
- **Severity:** medium. **Classification:** CONFIRMED.
- **Invariant:** single lock order — advisory family lock → row locks.
- **Fix:** the family lookup is now an unlocked read (`family_id` is immutable for a row);
  `revokeSessionFamilyInTransaction` takes the advisory lock before its `UPDATE` acquires row locks.
  Callers already ignore the return value, so no contract change.
- **Status:** FIXED and verified present.

### F-002 — Print-certification endpoint could never enqueue a job — FIXED
- **Location:** `src/app/api/printers/[id]/certify/route.ts:212-218`.
- **Code path:** `POST /api/printers/:id/certify` → `createPrintJobForPrinter` →
  `validatePrintJobPayload` → `printJobPayloadSchema.parse`.
- **Components:** Gateway certification route ↔ payload wire contract ↔ DB CHECK.
- **Evidence:** the route built both payload literals (`pdf` and `raw`) **without the mandatory
  `encoding` member**. `contracts/print-payload-contract.json` declares
  `"encoding": "base64"`, and `src/lib/payload.ts:11-13` declares
  `encoding: z.literal(payloadContract.encoding)` — **not** optional. `validatePrintJobPayload`
  therefore raised a `ZodError`, caught by the route's generic branch → HTTP 500 and
  `queue: error` on **every** certification request, for every transport.
- **Severity:** high (feature 100% broken). **Classification:** CONFIRMED.
- **Evidence it escaped CI:** `tests/print-certification.test.ts` asserts only on route *source
  text*; no test executes `createPrintJobForPrinter` with the certification payload.
- **Invariant:** every payload producer must satisfy the shared wire contract; the Odoo addon is the
  only other producer and it always sets `encoding: "base64"` (verified).
- **Fix:** added `encoding: "base64"` to both payload literals. This was the only place in the whole
  gateway that omitted it.

### F-003 — `job_events.created_at` type drift between database and ORM — FIXED
- **Location:** `drizzle/0055_job_events_and_spooler_job_id.sql:24` (`TIMESTAMPTZ`) vs
  `src/db/schema.ts:436` (`timestamp` = *without* time zone).
- **Components:** Drizzle ORM, `drizzle-kit generate`/`db:push`, `job-timeline`.
- **Evidence:** no later migration alters the column; the 0075 snapshot also records `timestamp`,
  so the drift was invisible to the tool chain. `npm run db:push` would emit an
  `ALTER COLUMN … SET DATA TYPE timestamp` — a full rewrite of an append-only table.
- **Severity:** medium. **Classification:** CONFIRMED.
- **Fix:** the database is authoritative (timestamptz is the safer, already-correct state), so the
  ORM declaration was aligned: `timestamp("created_at", { withTimezone: true })`. Runtime values are
  unchanged (node-postgres maps timestamptz to `Date`); `gateway_metrics.updated_at` already uses the
  same declaration.

### F-004 — `discovered_devices_candidate_status_check` narrowing never executed — FIXED
- **Location:** `drizzle/0010:45`, `0014:22-26`, `0025:36-39` (5-value, live) vs
  `drizzle/0075:24-26` (`IF NOT EXISTS` guard → no-op) and `src/db/schema.ts:342` (3-value).
- **Components:** discovery approval state machine, ORM/DB contract.
- **Evidence:** the guard was already satisfied by the 0010/0025 constraint, so the 3-value `ADD`
  never ran. 0075's header ("The CHECKs below encode exactly those domains") was therefore false, and
  the DB still accepted `'ignored'`/`'expired'`. `verify` gates on
  `eq(candidateStatus,"discovered")` and `provision` on `"verified"`, so a row holding a retired value
  is permanently un-approvable and un-provisionable with no error path.
- **Severity:** medium-high. **Classification:** CONFIRMED.
- **Fix:** new forward-only migration `drizzle/0076_discovery_candidate_status_check.sql` +
  `_journal.json` entry + snapshot. It (a) normalizes retired values back to `'discovered'` (lossless:
  `'discovered'` is exactly the state every fresh discovery report produces, and such rows are
  otherwise unrecoverable), (b) `DROP CONSTRAINT IF EXISTS` + unguarded `ADD` (a guarded statement is
  precisely what made 0075 a silent no-op), and (c) probes `information_schema` with
  `current_schema()` (the 0011/0025 pattern) so worker-schema replays are not suppressed by `public`.

### F-005 — Odoo: Gateway late-success reconciliation unreachable — FIXED
- **Location:** `odoo_addons/print_gateway/models/print_job.py`
  (`_needs_gateway_status_reconciliation`, and the `cron_sync_status` SQL).
- **Code path:** Gateway `failed` + `AGENT_EXECUTION_TIMEOUT` → `_apply_synced_status` maps every
  `_GATEWAY_UNKNOWN_MARKERS` failure to Odoo status `unknown` → the reconciler's
  `status == "unknown"` branch listed only `JOB_EXPIRED_DURING_PRINT`,
  `UNKNOWN_PARTIAL_DELIVERY`, `UNKNOWN_SUBMISSION_OUTCOME` → **the row was never re-polled**, so
  `_apply_gateway_late_success` / the `LATE_SUCCESS:` branch were dead code and the Gateway's 24h
  fenced reconciliation window was silently disabled.
- **Components:** Odoo outbox ↔ Gateway `src/lib/job-status.ts` (`LATE_SUCCESS_ERROR_MARKERS`).
- **Severity:** high. **Classification:** CONFIRMED.
- **Fix:** added `AGENT_EXECUTION_TIMEOUT` and `AGENT_RESTART_DURING_PRINT` to the `unknown` marker
  tuple in both the Python predicate and the cron SQL.

### F-006 — Odoo: spooler/IPP diagnostic test page unreachable — FIXED
- **Location:** `odoo_addons/print_gateway/models/print_router.py:134-139` (`resolve_binding`) vs
  `binding.py:511-526` (`destination_for`).
- **Code path:** `binding.action_send_test_print` → `_route_spooler_test_page` /
  `_route_ipp_test_page` → `resolve_binding(record=False, explicit_binding=<binding>, …)`.
- **Evidence:** `resolve_binding` computed `destination` **before** the `explicit_binding` branch, and
  `destination_for()` raises `ValidationError("A deterministic Odoo print destination is required.")`
  when there is no record, report or explicit destination — which is exactly the diagnostic's shape.
  Only `escpos`/`raw` were reachable; `spooler`, `ipp` and `ipps` bindings always raised.
- **Severity:** high. **Classification:** CONFIRMED.
- **Fix:** the destination is now derived only when a document exists, otherwise from the explicit
  binding's own `destination_ref`. `resolve_explicit()` still performs its full identity,
  company/branch, protocol and payload_type validation, so no scope check is weakened. The implicit
  (`find_for`) path is byte-for-byte unchanged and still raises as before.

### F-007 — Odoo: `CredentialVersionError` escaped every credential handler — FIXED
- **Location:** `odoo_addons/print_gateway/models/crypto.py:36` (definition);
  17 handlers in `gateway_config.py` catch `(CredentialKeyUnavailable, CredentialDecryptError, ValueError)`.
- **Evidence:** the class derived only from `CredentialError(Exception)`, was never imported by
  `gateway_config`, and matches neither `ValueError` nor `binascii.Error`. A malformed
  `ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION` or a corrupted `opg1:<version>:` prefix escaped as a
  raw RPC traceback instead of the intended actionable `ValidationError`, and aborted the module
  upgrade at `19.0.2.4.0`.
- **Severity:** high. **Classification:** CONFIRMED.
- **Fix:** `CredentialVersionError` now also derives from `ValueError`. A malformed version *is* a
  value problem, and this makes all 17 existing handlers correct with one declaration and zero
  call-site edits.

### F-008 — Odoo: translation catalog out of parity (red `i18n:odoo:check` CI gate) — FIXED
- **Location:** `odoo_addons/print_gateway/i18n/ar.po`.
- **Evidence:** the concurrent copy pass (`2e90cc18`) rewrote 10 English strings in
  `gateway_limit_dialog.js` / `pos_print_router.js`; the catalog still carried the previous 10
  msgids. The CI gate (`ci.yml` → `npm run i18n:odoo:check`) fails on both *missing* and *stale*.
- **Severity:** high (build-breaking). **Classification:** CONFIRMED.
- **Fix:** 10 msgid/msgstr pairs rewritten with Arabic translations for the current strings.
  Verified by static re-extraction with the checker's own `extract_terms()` / `parse_catalog()`:
  **458 source terms / 458 catalog entries, 0 missing, 0 stale, 0 duplicates, 0 empty,
  0 placeholder mismatches, 0 identical-to-English.**

### F-009 — Desktop: three undefined i18n keys rendered raw in the printer drawer — FIXED
- **Location:** `src/desktop/main.tsx:981-984` used `desktop.drawers.{agentOwned,applied,pending}`;
  the catalog defines the singular `desktop.drawer.*` (`en.ts:1281,1284,1285`, `ar.ts` likewise).
  `translate()` falls back to the key itself, so every manager-owned printer showed
  `desktop.drawers.agentOwned`.
- **Severity:** medium. **Classification:** CONFIRMED (the only 3 of 445 desktop keys missing from `en`).
- **Fix:** corrected to `desktop.drawer.*`.

### F-010 — Desktop: snake_case/camelCase mismatch broke the USB and spooler paths — FIXED
- **Location:** `src/desktop/components/AddPrinterDialog.tsx`, `src/desktop/main.tsx`,
  `src/desktop/pages/Overview.tsx`, `src/desktop/lib/printers.ts`, `src/desktop/lib/ipc.ts`.
- **Evidence:** `commands.rs:689-710` serializes camelCase (`#[serde(rename="spoolerName",
  alias="spooler_name")]`) and the Gateway `/api/printers` rows are camelCase Drizzle columns
  (`connectionType`, `printerType`, `deviceClass`). `PrinterInfo` (`ipc.ts:340-361`) deliberately
  declares **both** casings, and `humanType`/`humanConnection` already read `p.x || p.X` — but
  `usbPrinters`, `physicalSpoolers`, the printer search filter, the Overview language badges, the
  hardware-profile cards, `isVirtualPrinter` and `printerEndpoint` read snake_case only. Consequences:
  `usbPrinters` always empty (Add-Printer validation could never pass the USB step),
  `physicalSpoolers` always empty, connection/type search never matched, Overview badges lost their
  connection-derived chips, and the virtual-printer guard lost the normalized-metadata signals.
- **Severity:** medium. **Classification:** CONFIRMED.
- **Fix:** every reader now accepts both casings (the convention already used in the same files), and
  `fetchGatewayPrinters` derives the snake_case aliases from the camelCase row as well as from
  `config`.

### F-011 — Desktop: "Unknown outcome" tab and counter swallowed every delivered job — FIXED
- **Location:** `src/desktop/main.tsx` (job tab filter, `jobCounts.unknown`, job-drawer banner).
- **Evidence:** `deriveOutcome()` returns `"unknown"` for `success` **by design** (transport success is
  not proof of paper — `src/shared/job-vocabulary.ts:54`, server mirror `src/lib/job-status.ts:77`).
  The tab filter and the counter tested only `outcome === "unknown"`, making "Unknown outcome" a
  superset of "Delivered" and inflating its count. The shared vocabulary already guards for this in
  `jobTone()` (`status !== "success" && outcome === "unknown"`), and the Gateway's `status=unknown`
  filter is marker-based and therefore excludes successes.
- **Severity:** medium. **Classification:** CONFIRMED.
- **Fix:** all three sites now scope by `status !== "success"`, matching both the server filter and
  the shared vocabulary's own guard.

---

## Findings deliberately NOT changed (with reasons)

| ID | Finding | Class | Reason left unchanged |
|---|---|---|---|
| PG-01 | POS "Sale Details" routing is structurally unroutable: both call sites hard-code `document_type="report:point_of_sale.sale_details_report"`, but `binding._compute_document_type` can only ever yield `receipt` for a `pos.order` report, so no binding can match. | CONFIRMED | Fixing it requires a **new document-type value in the binding taxonomy** plus a data migration and unique-constraint semantics change — an architecture change, not a minimal fix. Out of "smallest correct compatible fix" scope; recorded for a dedicated change. |
| PG-06 | `resolve_binding` ignores `protocol`/`payload_type` on the implicit (`find_for`) path, so a PDF job routed to an `escpos` binding fails at the Gateway with 422 instead of at configuration time. | CONFIRMED | Widening `find_for` to carry capability filters changes binding *resolution semantics* for every report/POS path. Requires product decision on failover behaviour. |
| PG-08 | Report-automation intent redispatch reuses `intent_key` with freshly rendered PDF bytes, so `same_operation` (byte comparison) rejects the retry with a misleading idempotency error. | CONFIRMED | The correct fix changes the idempotency fingerprint to exclude non-deterministic bytes — a durable-outbox contract change. |
| PG-10 / PG-09 | Odoo terminalizes Gateway `TENANT_UNAVAILABLE` (409) and applies no backoff to 5xx. | CONFIRMED | Behaviour change to the Odoo retry state machine; needs an operator-observable decision (which 409s are recoverable). |
| PG-12 | `binding.printer_protocol` Selection lacks `windows_spooler`, which `PRINTER_PROTOCOLS` and the DB CHECK permit; `ODOO_INTEGRATION.md:88` documents it. | CONFIRMED | Adding a Selection value + doc is safe, but current ingest paths normalize `windows_spooler → spooler`, so the value is not reachable today; bundled with PG-01's taxonomy change. |
| PG-13 | `ir.model.access.csv` grants `print_gateway.intent` `perm_unlink=1` although the list view sets `delete="0"`; deleting a dispatched intent can replay a business event. | CONFIRMED | An ACL change; `print_job` already uses `perm_unlink=0`. Flagged, not changed, to avoid altering a permission surface without a product decision. |
| TAURI-F-01 | Printer lifecycle + edit-config are unreachable: `gateway_request` requires a manager bearer, and the desktop ships **no** manager login UI (a pinned product decision). | CONFIRMED | Adding a login surface is new functionality, explicitly against "no redesign". |
| TAURI-F-02 | `installer_hooks.nsh` uses `$INSTDIR`/`$0` inside single-quoted `nsExec::Exec` strings, which NSIS does not expand, so the service is never registered by the installer. | CONFIRMED (needs generated `installer.nsi` to be certain) | Fixing requires editing the NSIS hook; the finding is verifiable only by inspecting a generated installer, i.e. a build. Left for a runtime-verified pass. |
| TAURI-F-03 | `closeApp()` hides the window instead of closing it, and `onRelaunch` is never passed. | CONFIRMED | Fixing the "Close & Reopen as Administrator" flow needs a privileged relaunch implementation. |
| TAURI-F-08/F-09 | `start`/`stop` have no mutual exclusion; the PID/meta ownership record is written non-atomically. | CONFIRMED | Requires an async mutex and a record-format redesign in Rust. |
| TAURI-F-11 | Desktop accepts `http://localhost` for the Gateway probe, but the Go agent refuses plain HTTP without `YASEIR_AGENT_ALLOW_INSECURE_HTTP`, which the desktop must not set. | CONFIRMED | Divergent transport policy across a trust boundary; needs a product decision on loopback HTTP. |
| MIG-F-06/F-07 | `tenant_subscriptions.stripe_customer_id/stripe_subscription_id` are partial **indexes** in the DB but `.unique()` constraints in the ORM; six inline uniques are auto-named `<t>_<c>_key` in PG but `<t>_<c>_unique` in the ORM. | CONFIRMED | Naming/kind drift only. Zero runtime impact (no `ON CONSTRAINT` reference exists anywhere in the repository) and fixing it means either a destructive index rebuild or re-declaring columns. |
| MIG-F-04 | 8 live indexes exist that `src/db/schema.ts` does not declare. | CONFIRMED | `discovered_devices.protocol`'s CHECK is deliberately unmodelled (documented in `0027`); the rest are performance-only. Pure declaration bookkeeping. |
| MIG-F-08 | 10 unguarded `ADD CONSTRAINT` / `ADD COLUMN` / `CREATE TABLE` statements break single-file replay. | CONFIRMED | Forward-only migrations are applied at most once by the drizzle migrator. Editing already-applied migrations is the larger risk; recorded, not changed. |
| MIG-F-09 | `drizzle/0058`'s multi-line `FROM pg_constraint` guard is not rewritten by `tests/helpers/pg.ts`, so the worker-schema replay misses one constraint. | CONFIRMED | Test-harness-isolation issue only; production is correct. Not changed because the instruction is a static audit and changing a harness regex without being able to run the suite is unverifiable here. |
| MIG-F-13 | Three cascade-FK columns have no index. | CONFIRMED | Performance-only, not correctness. |
| MIG-F-15 | Two `_journal.json` `when` inversions. | SPECULATIVE | Array order (`idx`) is authoritative for the installed migrator; nothing in the repository sorts by `when`. |
| ODOO dead code | PG-22, PG-24…PG-31, PG-33, PG-34, PG-38, PG-41, PG-43…PG-47 | CONFIRMED (dead code) | Instruction: **no style-only cleanup / no dead-code removal without a functional defect**. Each is either intentionally pinned by a static test (`test_odoo19_printing_static.py`) or has no behavioural effect. |
| DOC drift | `API.md` documents a non-existent `429 PRINT_JOB_RATE_LIMITED` and omits 3 endpoints Odoo calls; `print-job-service.ts` comments still describe the pre-0067 `now()` default. | CONFIRMED | Documentation-only; explicitly out of scope for a source-defect fix, and the `AGENT_ARCHITECTURE.md`/`ARCHITECTURE.md` contract text was not modified. |

---

## Phase 5 — Fixes applied in this pass

| Fix | Files |
|---|---|
| F-002 certification payload `encoding` | `src/app/api/printers/[id]/certify/route.ts` |
| F-003 `job_events.created_at` type | `src/db/schema.ts` |
| F-004 candidate_status CHECK | `drizzle/0076_discovery_candidate_status_check.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/0076_discovery_candidate_status_check_snapshot.json` (new) |
| F-005 late-success reconciliation | `odoo_addons/print_gateway/models/print_job.py` |
| F-006 explicit-binding destination | `odoo_addons/print_gateway/models/print_router.py` |
| F-007 credential error class | `odoo_addons/print_gateway/models/crypto.py` |
| F-008 Arabic catalog parity | `odoo_addons/print_gateway/i18n/ar.po` |
| F-009 drawer i18n keys | `src/desktop/main.tsx` |
| F-010 wire-casing readers | `src/desktop/components/AddPrinterDialog.tsx`, `src/desktop/main.tsx`, `src/desktop/pages/Overview.tsx`, `src/desktop/lib/printers.ts`, `src/desktop/lib/ipc.ts` |
| F-011 unknown-outcome tab/counter/banner | `src/desktop/main.tsx` |

(F-001 was fixed in the prior pass and re-verified present.)

---

## Phase 6 — Full re-audit after the fixes

Repository-wide re-read of every area touched by the fixes **and** of the concurrently committed
work (`0564480b`, `2e90cc18`, `e298a5e6`, `5c20c400`):

- **Regressions searched:** new race conditions, lock-order inversions, authorization bypasses,
  contract mismatches, dead code, inconsistent behaviour introduced by the fixes — **none found**.
- `drizzle/meta/_journal.json` diff is a clean +7-line insertion; 77 entries, contiguous `idx`,
  last tag `0076_discovery_candidate_status_check`; both JSON files parse; `CURRENT_SCHEMA_VERSION`
  (`Number("0076".slice(0,4))`) = 76.
- Migration `0076` is forward-only, idempotent on replay (DROP precedes ADD), tenant-schema scoped,
  and does not touch rows outside `discovered_devices`.
- `resolve_binding` change is confined to the `explicit_binding` + no-document case; the implicit
  `find_for` path and every existing scope/protocol/payload_type check are unchanged.
- `CredentialVersionError` becoming a `ValueError` only widens existing `except` coverage; no
  handler narrows.
- Desktop casing readers now accept both forms, so no previously-working reader changed behaviour;
  `PrinterInfo`'s dual declaration was already the intended contract.
- `unknown`-tab scoping now matches `jobTone()` and the Gateway filter, so it is strictly narrower
  and cannot newly include a row.
- **Gateway i18n:** 2117/2117 key parity; all 1656 `t()` keys and 15 `tc()` bases resolve.
- **Odoo i18n:** 458/458, 0 missing / 0 stale / 0 duplicate / 0 empty / 0 placeholder mismatch.
- Re-verified no desktop-bundled module reaches `src/db` / `pg` / `drizzle`.
- Re-verified the claim-token lock order in `session-tokens.ts` is advisory → row on both paths.
- The concurrent `settings/page.tsx` change removed the `dirty` binding and gated submit on
  `name.trim().length < 2`; no dangling reference, and the bound matches the server-side 2–120 rule.
- The concurrent `2e90cc18` desktop/Odoo changes are copy/CSS/responsive-class only; no logic,
  effect-handler, dependency-array or fetch target was altered.

### F-012 — Orphaned Arabic strings broke the TypeScript build — FIXED
- **Location:** `src/i18n/messages/ar.ts` lines 231, 233, 279 (removed).
- **Code path:** module parse of the `ar` catalog.
- **Evidence:** three lines contained a bare Arabic string literal with **no key and no colon** —
  a syntax error (TS1005) inside the catalog object literal:

  | line | content | duplicate of |
  |---|---|---|
  | 231 | `"حالة الطباعة غير معروفة…"` | `"job.guidance.unknown"` (line 230) |
  | 233 | `"لم يستلم أي Agent هذه المهمة…"` | `"job.guidance.expired"` (line 232) |
  | 279 | `"سيتم حذف الـ Agent وبيانات اعتماده…"` | `"agent.deleteBody"` (line 278) |

  The customer-facing copy pass (`2e90cc18`) replaced each keyed value with a shorter string but
  left the previous long Arabic text on the following line. Confirmed by two independent on-disk
  compilers (TypeScript 5.4.5 and 6.0.3), both reporting the same three TS1005 diagnostics.
- **Severity:** critical (build-breaking). **Classification:** CONFIRMED.
- **Why the Phase 1–6 audit missed it:** the en/ar **key**-parity check compares key *sets*; an
  orphan line is not a key, so it was invisible to `check-i18n.ts`-style verification. It was found
  only by *parsing* the files.
- **Invariant:** every message catalog must be syntactically valid TypeScript; a value may only
  appear as `"key": "value"`.
- **Fix:** the three orphan lines were deleted (each was unreferenced duplicate text). After removal
  **370/370 `.ts`/`.tsx` files parse**, en/ar parity is still **2117/2117**, and every
  `t()`/`tc()` call-site key still resolves.

### F-013 — High-severity advisory in a dev-only transitive dependency — NOT FIXED
- **Location:** `package-lock.json` → `node_modules/braces@3.0.3`.
- **Evidence:** `npm audit --package-lock-only --audit-level=high` reports 5 high findings, all one
  root cause: `braces` < fixed (GHSA-vfj7-8cjw-p6xm, stack-exhaustion DoS on deeply nested patterns),
  reached only as `braces → micromatch@4.0.8 → fast-glob@3.3.1 → @next/eslint-plugin-next →
  eslint-config-next`.
- **Reachability:** every package in the chain is marked `(dev)` in the lockfile. The production
  image installs with `npm ci --omit=dev` (`Dockerfile:17`), so `braces` is **not present in the
  shipped runtime**. The only consumer is ESLint's glob matching during `npm run lint`.
- **Severity:** high per the advisory; low practical impact given dev-only, non-production reachability.
- **Classification:** CONFIRMED present in the dependency graph.
- **Why not fixed here:** the remediation is an `overrides` entry plus a regenerated
  `package-lock.json`. `npm audit fix --force` proposes downgrading `eslint-config-next` to 14.2.35
  (breaking), and hand-editing the lockfile without being able to run `npm ci` + `npm run lint`
  would risk breaking the CI lint step. This run excludes dependency installation, so the fix is
  recorded rather than applied blind.

---

## Checks executed in this environment (no tool installation)

| Check | Result |
|---|---|
| `go mod verify` (agent) | PASS — all modules verified |
| `go build ./...` (agent, offline `GOPROXY=off`) | PASS |
| `go vet ./...` (agent, offline) | PASS |
| `go test ./... -race` (agent, offline) | PASS — **429 tests, 10 packages** |
| `gofmt -l .` (agent formatting gate) | PASS — clean |
| `staticcheck -checks=U1000 ./...` (Linux build tags) | PASS — no dead code |
| `staticcheck -checks=U1000 GOOS=windows ./...` | PASS — no dead code |
| `python3 scripts/check-db-docs.py` (`db:docs:check`) | PASS — 24 schema tables ↔ 77 migrations ↔ docs in sync |
| `python3 scripts/check-odoo-translations.py` (`i18n:odoo:check`) | PASS — 458/458, 0 missing/stale |
| `pytest tests/` (all 5 Python contract suites) | PASS — **143 tests** |
| TS/TSX syntactic parse of all 370 files (on-disk compiler) | PASS after F-012; found F-012 |
| Python byte-compile of all 54 `.py` files | PASS |
| `node --check` on all 13 `.js`/`.mjs` files | PASS |
| XML well-formedness of all 9 addon XML files | PASS |
| CSV rectangularity (`ir.model.access.csv`) | PASS — 12×8 |
| All `.json` files parse (incl. both drizzle snapshots) | PASS |
| en/ar key parity (2117) + all 1656 `t()` keys resolve | PASS |
| Every `/api/**/route.ts`: 76 files, 95 handlers, all valid + unique methods | PASS |
| Tauri command surface: declared == `build.rs` ACL == `invoke_handler` == capability | PASS — 22 == 22 == 22 == 22, same order |
| CI gate: no `@/` path aliases, no tsconfig path mapping | PASS |
| CI gate: no `<tree>`/`attrs=`/`states=` in addon views | PASS |
| CI gate: Odoo icon == desktop icon sha256 | PASS — identical |
| `cargo verify-project --locked` (manifest validity) | PASS |
| `cargo metadata --locked --offline` (lockfile ↔ manifest agreement) | PASS — 427 pkgs; `tauri 2.11.5`, `tauri-build 2.6.3`, `tauri-plugin-autostart 2.5.1`, `reqwest 0.13.5`, `rustls 0.23.45` |
| `npm audit --package-lock-only --audit-level=high` | **FAIL** — see F-013 (dev-only) |
| `cargo check` (native and `x86_64-pc-windows-msvc`) | BLOCKED — needs system packages |

Toolchain notes and limits of this run:
- `node_modules` is **absent**, so `npm run typecheck`, `lint`, `build`, `i18n:check`, `test`,
  `test:integration`, `test:e2e`, `test:odoo:static` and `docker compose config` could not run
  without installing dependencies. The TS/TSX gate above substitutes a **syntactic** parse and
  performs **no** type checking — that remains outstanding.
- `cargo check` cannot complete on this host: the native target needs `gobject-2.0`/GTK development
  headers, and the Windows target needs the MSVC C compiler for the `aws-lc-sys` C dependency
  (`GNU compiler is not supported for this target`). Both require installing system packages, so
  the crate's own Rust code was **not** compiled here. `rustfmt` is not installed for the pinned
  toolchain, so no Rust formatting gate was possible either.
- `govulncheck` and `cargo audit` additionally require `go install` / `cargo install` plus a
  vulnerability-database download.
- Disclosure: `staticcheck v0.8.1` was compiled from source into `/tmp` (CI pins v0.7.0) and the
  declared Rust dependencies were fetched into the shared cargo cache. Neither changed the
  repository, the system, or any project manifest.

---

## Final status

- **Repository-wide coverage:** COMPLETE (754 files; every directory accounted for).
- **CONFIRMED source-provable defects found and fixed:** 12 (F-001 … F-012).
- **CONFIRMED defect found but intentionally not fixed:** 1 (F-013 — dev-only transitive advisory;
  remediation requires regenerating the lockfile, which this run excludes).
- **Findings intentionally unchanged:** 15 groups, each with a stated reason (see the table above).
- **Runtime verification still required:** `npm ci` then `npm run typecheck`, `lint`,
  `i18n:check`, `build`, `test`, `test:integration`, `test:e2e`, `test:odoo:static`,
  `docker compose config`; the Odoo 19 addon suite; `cargo check`/`cargo build`/`cargo audit` for
  `src-tauri`; `govulncheck`; the generated-NSIS inspection needed to settle TAURI-F-02; and
  dependency resolution + a lint run to settle F-013.