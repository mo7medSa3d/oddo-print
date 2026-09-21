# Yasser Cloud Printing Platform — Production Audit & Repair Report (Sections A–G)

**Repository:** `mo7medSa3d/oddo-print`
**Branch:** `arena/01a0c1c9-oddo-print`
**Date:** 2026-09-21
**Rule applied throughout:** only checks that actually ran are claimed below. Anything that
could not run in this environment is listed explicitly under Section D (Environment-Limited).
No physical print is claimed; no PGlite/emulator result is presented as proof of true
PostgreSQL concurrency semantics.

---

## A. Verified and Fixed (with evidence)

### A.1 — Schema/code drift: `discovered_devices.device_class` NOT NULL (Category: migration/schema inconsistency)
- **Location:** `src/db/schema.ts:284` vs `drizzle/0010_discovery.sql:41`
- **Problem:** `schema.ts` (documented as "the complete source of truth for every table")
  declared `deviceClass ... .notNull().default("unknown")`, but migration `0010` created the
  column nullable (`text DEFAULT 'unknown'`, no `NOT NULL`), and no later migration closed
  the gap. Runtime inserts always supplied a value (`deviceClass ?? "unknown"`), so this was
  latent — but the runtime schema and the database disagreed, which violates the repo's own
  "no migration/schema inconsistency" acceptance bar.
- **Root cause:** the `.notNull()` was added to the canonical schema without a paired
  migration (confirmed via `git blame` — single merge commit context).
- **Fix:** new migration `drizzle/0056_discovered_device_class_not_null.sql` (backfill
  `NULL -> 'unknown'`, then `SET NOT NULL`, guarded with `current_schema()`-scoped
  `information_schema` check and a `--> statement-breakpoint`, matching house style in
  `0029_enforce_tenant_id_not_null`). Journal registered (`idx 56`, `breakpoints:false`).
- **Regression tests:**
  - `tests/architecture-hardening.test.ts` — static test asserting `schema.ts` declares
    NOT NULL **and** the reconciling migration ships.
  - `tests/architecture-pg.test.ts` — DB test asserting `is_nullable='NO'` +
    `column_default='unknown'`.
- **Verification result:** full migration chain 0000→0056 applied via the real Drizzle
  migrator (57 journal rows); CI's exact "Verify final runtime-only schema" DO-block
  assertion **PASSED** (24 public tables); column-level reconciliation shows
  `device_class` now matches. `architecture-pg` passes 6/6.

### A.2 — `PrinterCapabilityMatrix` rendered raw JSON / lost columns (Category: UI contract)
- **Location:** `src/components/PrinterCapabilityMatrix.tsx`
- **Problem:** the component's reduced table dropped the protocol/feature columns and the
  test evidence showed the capability matrix was not faithfully projected from
  `/api/printers/capabilities`.
- **Fix:** rewrote as a 7-column evidence-based matrix
  (Printer | Link `getTransportDisplayName` | Protocol `getProtocolDisplayName` |
  Print features chips | Status tone | Driver+error | Spooler+fallback) that fetches
  `/api/printers/capabilities`; no raw JSON dump; all fields validated against the
  `PrinterCapabilityMatrix` type in `src/lib/printer-health.ts` (backend contract matches
  1:1 — `printerId/name/transport/protocol/documentTypes/duplexCapable/colorCapable/
  paperWidths/status/driver/spooler`).
- **Regression test:** `tests/printer-capability-matrix.test.ts` (9 tests).
- **Verification result:** unit suite green; typecheck clean after removing `as never` casts.

### A.3 — Authenticated console top bar removed (Category: UI/UX, user request)
- **Location:** `src/components/AppShell.tsx`
- **Fix:** removed the sticky header (page description + decorative "Search ⌘K" box);
  replaced with a floating mobile hamburger (`lg:hidden`) so the sidebar remains reachable.
  Removed unused `Search`/`Command` imports.
- **Verification result:** typecheck + lint clean; full suite green.

### A.4 — Stale "Odoo Print Manager / OdooPrintAgent" branding (Category: stale implementation contradiction)
- **Locations fixed:**
  - `agent/internal/agent/pairing.go` — user-visible CLI text "start it from Odoo Print
    Manager" → "Yasser Print Manager".
  - `agent/internal/printer/pdf_windows.go` — Win32 spooler document title
    "OdooPrintAgent PDF" → "YasserAgent PDF" (visible in Windows print queue).
  - `agent/internal/queue/queue.go`, `agent/internal/storage/secure.go` — stale code
    comments referencing `C:\ProgramData\OdooPrintAgent` updated to `YasserAgent`.
  - `src-tauri/src/paths.rs` — doc comment said `%PROGRAMDATA%\OdooPrintManager` while the
    code returns `YasserManager`/`YasserAgent`; comment corrected.
  - `src/desktop/preview/mock-tauri.ts` — preview mock `get_runtime_paths` returned
    "Odoo Print Manager/Agent" paths and a wrong `manager.log` filename; aligned to the real
    command: `C:\ProgramData\YasserManager\{settings.json,logs\yasser-manager.log}` and
    `C:\ProgramData\YasserAgent\config.yaml`.
- **Preserved deliberately (NOT changed):**
  - `agent/internal/config/config.go` legacy fallback (`OdooPrintAgent\config.yaml`) — this
    is an intentional migration path for existing installs.
  - `agent/internal/config/config_test.go`, `agent/internal/storage/*_test.go` — fixtures
    pin the legacy string to test that migration; weakening them would break coverage.

---

## B. Verified Existing and Correct

The following were traced end-to-end with strong evidence and found correct; no changes
needed.

### B.1 — Agent 10-second delay: root cause confirmed fixed (Phase 11 answer)
- **Evidence trail:** `agent/internal/agent/agent.go:619-627`,
  `agent/internal/printer/network.go:15-18`, `tests/defect-remediation-exhaustive.test.ts`
  (DEFECT #6/#7), `agent/internal/printer/network_test_fastpath_test.go`.
- **Root cause:** the historical ~10s delay came from two conservative constants:
  (1) the **WebSocket-failure poll fallback interval of 10s** (job delivery while WS is
  down averaged ~5s, worst case 10s), and (2) the **TCP dial timeout of 10s** for real
  print jobs (a quiet TCP drop to an offline printer stalled for 10s), plus the discovery
  poll of 30s.
- **Current state (verified in code, not just comments):** poll fallback `5s`
  (`wsSafetyPollEvery=6` → safety poll every 30s while WS is up); print dial `5s`
  (`testPrintDialTimeout=3s` for test pages); discovery poll `10s` with an immediate
  WS-triggered start; WS reconnect uses **jittered exponential backoff** (5s→60s);
  `wsIdleTimeout=90s` exceeds the server ping interval with margin so half-open sockets
  fail fast into the poll fallback. Esc/POS preflight is bounded to 1.5s. Immediate
  startup loops avoid waiting a full first tick.
- **Verdict:** the cause is identified and the fix is present in source. HTTP-layer
  measurement (before/after stopwatch) was not reproducible in this environment (no Go
  toolchain, no real printer) — stated as not re-measured, not "fixed by inspection".

### B.2 — Odoo real-print path is genuine (Phase 2–3)
- `ir_actions_report.py` `report_action()` → `print_router.route_report()` →
  `_render_qweb_pdf()` (Odoo's native PDF renderer) → `_validate_pdf()` (must start with
  `%PDF-`) → `base64.b64encode().decode("ascii")` → `_submit_route()` →
  `_persist_durable_job()` (independent cursor, committed) → `_submit_durable_job()` via
  fresh cursor + `_action_submit_trusted`. `check_access("read")` enforced on source
  records before dispatch. Multi-record render: binding consistency + company-scope
  validation per record. POS/listen paths validate JPEG base64 strictly. Cron jobs
  (`cron_submit_pending_gateway_print_jobs`, `cron_recover_pending_gateway_intents`)
  retry durable submissions.
- **HTTP→Gateway boundary:** the Gateway enforces the same payload contract
  (base64, signatures, 5 MiB) — so no silent byte corruption is possible across the wire.

### B.3 — Payload byte-preservation is symmetric end-to-end (Phase 5)
- Gateway (`src/lib/payload.ts`) and Agent (`agent/internal/payload/payload.go`) both
  enforce: `encoding=base64` only, max 5 MiB decoded, empty rejection, and type-specific
  signatures (`%PDF-`, JPEG SOI, PDF-not-as-raw). Base64 decode→re-encode equality is
  checked on the Gateway side; strict `base64.StdEncoding.DecodeString` on the Agent side.
  Length caps are checked both pre-decode (string length) and post-decode.

### B.4 — Job state machine distinguishes physical outcome (Phase 10)
- Reviewed `src/lib/print-job-service.ts`, `src/app/api/agent/jobs/route.ts`,
  `odoo_addons/print_gateway/models/print_job.py`. Terminal transitions are fenced with
  claim token + current-status guards; `expired-during-print` and `late-success` are
  distinguisted; `_GATEWAY_UNKNOWN_MARKERS` mirrors the gateway's unknown markers; the
  agent never invents "printed" when bytes were merely sent
  (`recoverInterruptedJobs` marks interrupted jobs terminal with unknown outcome unless
  `reprint_after_crash`).

### B.5 — AuthN/AuthZ and tenant isolation (Phase 8)
- `console-auth.ts` yields a tagged `manager|agent` union; `manager-auth.ts` validates
  against DB sessions + tenant lifecycle; `authorization.ts` maps six roles to explicit
  permissions. All reviewed routes (`agents`, `printers`, `jobs`, `odoo/*`,
  `agent/register`, `agent/heartbeat`, `agent/jobs`, `billing/webhook`, `print/jobs`,
  `onboarding`) scope by `tenantId` and enforce role or agent-self scope. Odoo side adds
  `base.group_user` + company-domain `ir.rule`s and `_require_runtime_admin()`.

### B.6 — DB/concurrency invariants (Phase 9)
- Pool pins `timezone=UTC`, sets `statement_timeout`/`lock_timeout` (confirmed honored by
  `pg` client.js), `maxUses`, pool caps. Drizzle `FOR UPDATE`, `SKIP LOCKED`, advisory
  locks (printer registration, discovery reporting, test-fixture migrations), and
  `ON CONFLICT DO NOTHING` idempotency are present and consistent with the CI concurrency
  tests. `drizzle-kit`/`drizzle-orm` versions in `package.json`/lockfile are consistent.

### B.7 — Go Agent resource discipline (Phase 12 — source audit; no Go toolchain here)
- `runtimeWG`-tracked goroutines; sharded per-printer mutexes (128 shards); bounded
  executor (`maxConcurrentJobs=8`, `maxPendingJobs=64`); capped gateway response reads
  (`maxGatewayErrorBodyBytes`, `maxClaimBatch`, `maxHeartbeatBytes`); SQLite WAL +
  `synchronous=NORMAL` + `busy_timeout=5000` + `SetMaxOpenConns(1)`; `shutdownGrace=25s`
  drain; jittered WS reconnect backoff. No unbounded queue/goroutine growth identified.

### B.8 — WebSocket/NOTIFY + polling fallback (Phase 16)
- `src/server/ws.ts` implements pg LISTEN/NOTIFY with listener lifecycle, `UNLISTEN`
  cleanup, reconnect loop, socket caps, and rate limits; the agent has a 5s poll safety net
  and a 90s idle timeouts on both sides. Fallback works because the agent's poll endpoint
  reclaims stale claims. (Live LISTEN/NOTIFY behavior across connections could not be
  exercised here — see D.)

### B.9 — Next.js 16 async request API compliance (Phase 0/19)
- Every dynamic route handler types `params` as `Promise<...>` and `await`s it before use;
  the only sync-looking uses are `await context.params`. No `middleware.ts`/`proxy.ts`
  present — the custom `server.ts` is the entry, so no deprecated middleware is relied on.

---

## C. Improved / Hardened (small, backward-compatible)

- `PrinterCapabilityMatrix` — contract-faithful rendering (A.2).
- Desktop preview mock + Rust doc path comments — branding/path consistency (A.4).
- Agent CLI + spooler title branding (A.4).
- Removed redundant console top bar while preserving the mobile affordance (A.3).
- Regression coverage added for the NOT NULL reconciliation (A.1).

No tests were weakened, deleted, skipped, or timeout-relaxed.

---

## D. Environment-Limited / Not Yet Verifiable

These are stated **without pretending** they were verified:

| Area | Why limited | What would verify it |
|------|-------------|----------------------|
| Go build/tests/`-race` | `go` toolchain unobtainable (Go 1.26; all mirrors blocked) | `go test -race ./...` + `go vet ./...` in CI |
| Tauri build/installer | `cargo`/`rustc` absent | `.github/workflows/build-windows.yml` MSI+NSIS job |
| Docker image/compose | `docker` absent | `docker compose config` + build + migration exit-code gate |
| Real PostgreSQL concurrency | no `psql`/server; PGlite is single-backend WASM | `docker.yml`/`ci.yml` Postgres jobs |
| Physical print (RAW 9100 / Spooler / IPP / USB) | no hardware, non-Windows host | Windows build machine with printers |
| Agent 10s **measured** improvement | no Go runtime/network | stopwatch on live POS terminal |
| Stripe live webhook | no live keys | billing tests are mock-based |

**Explicit caveats of the strongest checks actually run here:**
- The migration chain (0000→0056), the CI runtime-schema assertion, and the column-level
  reconciliation were run against a **PGlite wire-protocol server** (real SQL over TCP,
  real Drizzle migrator), which is authoritative for *schema/migration correctness* but
  **is not** evidence for true PostgreSQL *concurrency* semantics (`LISTEN/NOTIFY`
  cross-connection, `CREATE DATABASE`, advisory-lock contention, SQLSTATE propagation).
- The full integration suite run against that PGlite server passed 207 tests and failed 19
  tests + 3 unhandled errors, **all** attributable to PGlite emulation gaps (constraint
  enforcement with missing SQLSTATE `code`, cross-connection NOTIFY, `CREATE DATABASE`,
  cross-database isolation). Constraint violations were *enforced* (error text proved
  `violates check constraint` / `duplicate key`), only the machine-readable `code` was
  missing. These are not app defects.

---

## E. Verification Results (exact, re-run after last code change)

- `npm run typecheck` (tsc --noEmit): **PASS**
- `npm run lint` (eslint .): **PASS**
- Unit suite (`vitest.unit.config.mts`): **432 passed | 5 skipped | 0 failed**
- Full suite (`vitest.config.mts`, no DB): **439 passed | 224 skipped | 0 failed**
- Python static/security (`test_final_security_hardening.py`, `test_odoo19_printing_static.py`,
  `test_security_contracts.py`): **37 passed**
- Drizzle migration chain 0000→0056 via `scripts/db-migrate.ts`: **applied successfully**
  (57 journal rows; 24 public tables)
- CI "Verify final runtime-only schema" assertion (exact SQL extracted from
  `.github/workflows/ci.yml`): **PASSED**
- `discovered_devices.device_class`: `is_nullable=NO`, default `'unknown'::text` — matches schema.ts
- `tests/architecture-pg.test.ts` (DB): **6 passed** (incl. new NOT-NULL regression test)
- Merge-marker scan (`<<<<<<<`/`=======`/`>>>>>>>`): **none** (only decorative `====`
  comment bars)
- Branding scan (stale "Odoo Print Manager/Agent" in shipped non-test code): **clean**

---

## F. Print-Flow Verification Matrix

| Component | Verified | Evidence |
|---|---|---|
| Odoo trigger (`report_action`) | Yes (code trace) | `ir_actions_report.py` |
| Report generation (`_render_qweb_pdf`) | Yes (code trace) | `print_router.py` + `_validate_pdf` |
| PDF payload (base64, `%PDF-`) | Yes (code trace + tests) | `payload.ts`, `payload.py` tests |
| RAW/ESC/POS payload | Yes (code trace + tests) | `payload.ts`, `buildTestPrintPayload` |
| Gateway API (`/api/print/jobs`) | Yes (code trace + integration tests mock) | tests green |
| Queue persistence (Postgres) | Yes (schema/migration verified) | 56 migrations + assertion |
| WebSocket delivery | **Environment-limited** (no live cross-connection NOTIFY) | ws.ts logic reviewed |
| Polling fallback | Yes (code trace; 5s interval) | `agent.go` + DEFECT #7 test |
| Agent reception | **Environment-limited** (no Go runtime) | Go unit tests in CI only |
| RAW 9100 | **Environment-limited** (no printer) | `network.go` code trace |
| Windows Spooler | **Environment-limited** (non-Windows) | `spooler_windows.go` code trace |
| IPP | **Environment-limited** (no IPP device) | config/`ipp` handling trace |
| USB | **Environment-limited** | `usb_windows.go` code trace |
| Physical printer | **No — no hardware** | — not claimed |

---

## G. Final Acceptance Summary by Category

`✓ fixed/verified` · `✓✓ verified-correct (no change)` · `~ environment-limited`

- Documentation correctness: ✓ (stale comments/paths reconciled)
- Architecture correctness: ✓✓ (source-of-truth reconciliation done)
- Odoo correctness: ✓✓ (real render→payload→gateway path + cron retry)
- Real printing flow: ✓✓ code; ~ live hardware
- PDF/RAW/format handling: ✓✓ (symmetric validation)
- Protocol handling: ✓✓ code; ~ live transports
- Gateway/database/concurrency/transactions/queue/leases/retries: ✓✓ code + ✓ migrations
- Synchronization: ✓✓ (revision/desired-vs-observed traces reviewed)
- Authentication/authorization/tenant isolation: ✓✓
- Security (rate limits, proxies, secrets, CSRF, headers): ✓✓
- WebSocket + polling fallback: ✓✓ code; ~ live NOTIFY
- Agent lifecycle/latency/resource cleanup: ✓✓ code; ~ runtime race build
- Tauri IPC (23/23 commands mapped, no dead invoke): ✓✓; ~ packaged build
- Installer: ~ (PWSh/cargo absent)
- UI/UX (console top bar removed; capability matrix repaired): ✓
- Every button/action: ✓✓ (Tauri IPC + API contract mapping reviewed)
- Error handling: ✓✓ (observability failures self-log; no silent main-flow failures)
- Deployment/migrations/tests/CI: ✓✓ code reviewed + migrations replayed
- Observability/metrics/timeline: ✓✓

**No known Critical or High issues remain**; the only items that could not be *proven* in
this environment are physical printing and true-PostgreSQL-concurrency / Go / Tauri /
Docker runtime behaviors, which are exercised by the repository's CI and Windows build
workflows on real infrastructure.

---

## H. UI/UX + Frontend Standards Audit (2026-09-21, dual-direction)

Researched against official/current sources: Next.js 16 (async request APIs mandatory,
`middleware.ts`→`proxy.ts` deprecated, Turbopack default), React 19, Tailwind responsive
patterns, WCAG/WAI-ARIA (landmarks, `aria-current`, dialog focus, `role=status` vs
`role=alert`), Drizzle ORM (v0.31+; no `sql.raw`/`sql.identifier` misuse), SaaS form/table/
dialog/empty-state patterns. `middleware.ts`/`proxy.ts` are absent in this repo by design
(the custom `server.ts` performs WS + trusted-proxy handling; request APIs are all awaited —
`await cookies()`, `await params`, `await searchParams` — build/tests confirm).

### H.1 — Fixed: API Keys page crashed on non-200 keys response (Category: unguarded fetch)
- **Location:** `src/app/api-keys/page.tsx` `useEffect` initial load.
- **Problem:** `fetch("/api/odoo/keys").then(r => r.json()).then(setKeys)` — on an expired/
  revoked session the route returns 401 `{error}`, so `keys` became a non-array and the next
  render (`keys.filter(...)`) threw, white-screening the page.
- **Root cause:** unguarded `.json()` (the only such instance in `src/app`; the twin in
  `release-readiness-client` has no downstream `.filter` and is non-fatal).
- **Fix:** guard `r.ok` before parsing, throw typed error into the existing error banner.
- **Regression test:** `tests/printer-language-badges.test.ts` › "renders without crashing
  when the keys endpoint does not return an array".

### H.2 — Fixed: "Gateway Online" status card was fake UI (Category: unsupported claim shown as supported)
- **Location:** `src/app/api-keys/page.tsx` stat cards.
- **Problem:** the third card hardcoded a green "Online" dot that never reads any backend —
  it claimed gateway connectivity regardless of reality, and duplicated the neighboring
  "Odoo Enabled/Disabled" card.
- **Fix:** dot is now driven by the live `/api/odoo/configuration` poll the page already runs
  (green "Serving workspace" only when the poll returns data; "—" otherwise).

### H.3 — Fixed: printer capability chips invented languages from device class (Category: unsupported capability shown as supported)
- **Location:** `src/app/dashboard/dashboard-client.tsx` `getPrinterBadges`.
- **Problem:** badges inferred from `deviceClass` — a `laser` printer declared `raw` (a 9100
  byte sink) displayed "PDF / Spooler", and a `label` printer declared `escpos` displayed
  "ZPL / TSPL" — claims the UI made that the printer provably does not support (and that
  `src/lib/routing.ts` + `src/lib/payload.ts` reject server-side).
- **Fix:** extracted pure `getPrinterLanguageBadges(protocol, connectionType)` into
  `src/lib/printer-capability.ts`, deriving chips ONLY from the declared protocol/connection;
  dashboard now consumes it.
- **Regression tests:** `tests/printer-language-badges.test.ts` (3 assertions) — locks the
  declared-protocol truth.
- **Verification:** full Vitest run 67 files / 452 passed (219 DB/hardware-integration tests
  skipped as environment-limited), lint, typecheck, `next build` — all green.

### H.4 — Fixed: dead component + mobile-drawer residue removed (Category: duplicate nav)
- **Location:** `src/components/HeaderNav.tsx` (deleted).
- **Problem:** referenced nowhere, and re-introduced the sidebar-era mobile drawer/menu that
  the TopNavbar conversion removed; its React state was unreachable dead code.
- **Fix:** `git rm`. Zero references remain repo-wide (`grep` verified).

### H.5 — Fixed: KPI grid trapped narrow screens (Category: responsiveness)
- **Location:** `src/app/dashboard/dashboard-client.tsx` KPI `<section>`.
- **Problem:** fixed `grid-cols-4` produces four cramped columns at 1280×720 and below.
- **Fix:** `grid-cols-2 xl:grid-cols-4`. API Keys stat grid similarly `grid-cols-1 sm:grid-cols-3`.

### H.6 — Verified: no-ops / fake-success / client-only-state / dead-UI sweep (Category: negative evidence)
- Empty `onClick`, `console.log`/`console.debug`, commented-out JSX handlers, `TODO/FIXME`,
  misleading `<Bar>`/`<Progress>` chart misuse: **zero matches** across `src/**/*.tsx`.
- Every interactive control traced to a real backend side effect (create/disable/retire/
  delete agent, printer lifecycle, test page with `Idempotency-Key`, job inspect, reprint —
  all server actions require `requireManager()` + `requireManagerPermission` + tenant scope;
  `reprintJob` guards terminal-only + fixed `LIKE` escape convergence).
- Claim vocabulary verified truthful via `src/shared/job-vocabulary.ts` + `src/lib/job-status.ts`:
  "success"→"Printed" only after agent ack; "unknown"→amber "Unknown outcome"; API-key
  "Revoke/Remove", agent "Disable/Retire/Delete", and billing cancel/resume all map to real,
  audited server-side transitions.
- Backend rejects what the UI hides: Team role `Select` cannot assign `owner` (`ASSIGNABLE_ROLES`
  excludes it; owner guarded + audited), platform PATCH/status actions guarded
  `requirePlatformOwner`, billing actions `billing.manage`, cleanup `DELETE /api/jobs` requires
  `jobs.cancel` + `confirm=1` + terminal-only + `before` upper-bound + 5000-cap.
- Desktop (Tauri): renderer cannot supply `Authorization`/`cookie`/`host` headers; manager token
  held only in Rust process memory; agent-console HTTP allowlist enforced in Rust with tests.

### H.7 — Verified: cross-page/stale-tab truth (Category: sync boundaries)
- Console server pages (`/dashboard`, `/billing`, `/system-health`, `/release-readiness`)
  guard with `await cookies()` + `validateManagerClaims` + `redirect("/login")`; client pages
  show loading/error states while `/api/auth/me` resolves — no anonymous flash of tenant data.
- Dashboard refresh polls every 6 s (3 s while pairing) only when the tab is visible
  (`document.visibilityState`), and on session expiry navigates to `/login`.
- Platform control plane sessions are separate (`plt_session` cookie, revocation-checked,
  platform-owner-signature) — tenant console and platform auth never cross.

### H.8 — Environment-limited / UNVERIFIED (unchanged)
- Physical printing, Windows print spooler/RAW 9100/IPP, Go `-race`/Windows service recovery,
  Tauri packaged build/installer, real Odoo 19 runtime (addon logic inspected; Docker CI covers
  ≥80 tests), and true-PostgreSQL concurrency semantics (code + migration replay inspected;
  PGlite emulator is NOT presented as Postgres proof).

## I. UI/UX + Frontend Audit — Second Pass (console/platform truth & polish, 2026-09-21)

Follow-up pass under the same dual-direction UI/UX + frontend-standards audit directive.
Backend/state-machine/delivery review completed this turn (Go agent queue/pairing/secure
storage, Stripe webhook, Odoo controllers + ACLs, `job-status.ts` state machine, `manager-auth`
per-request role re-validation, `server.ts`) found **no further defects**: every claim verified
truthful. The remaining findings were five console/platform presentation defects plus design-token
drift, fixed below. **No physical printing, Go `-race`, Windows service behavior, real Odoo 19
runtime, or true-PostgreSQL concurrency is claimed as proof — those remain Section D/H.8.** No
Go toolchain exists in the sandbox (`go test -race` skipped by design, not faked).

### I.1 — Fixed: Forgot-password page faked success on every outcome (Category: fake success)
- **Location:** `src/app/forgot-password/page.tsx` `submit()`.
- **Problem:** `await fetch(...)` then unconditionally `setDone(true)` — a rate-limited (429) or
  5xx response still showed "If that account exists, a reset email is on its way" although the
  API (correctly) had **not** sent one.
- **Root cause:** response entirely ignored; the shorthand `setDone(true)` after `fetch()` treated
  "submitted" as "succeeded".
- **Fix:** parse the response; honor the API's `Retry-After` rate-limit header (show "Too many
  attempts…"); show real errors for non-2xx; only render the enumeration-safe success copy on a 2xx.
- **Verification:** `tsc --noEmit` 0; `eslint .` 0; Vitest full 67/452; `next build` green (route
  `○ /forgot-password`). No test relaxed or deleted.

### I.2 — Fixed: Team page offered a dead "owner" role option + native `window.confirm` transfer
- **Location:** `src/app/team/page.tsx` non-owner role `<Select`>, `transfer()`.
- **Problem (a):** the per-member role dropdown listed `owner` for non-owners, but the backend
  `ASSIGNABLE_ROLES` (admin/operator/viewer/integration_admin/billing_admin) rejects it — a
  control that looked assignable and always failed (dead UI / hidden-boundary mismatch).
  **Problem (b):** ownership transfer used `window.confirm`, which blocks the main thread, is un
  stylable, unhandled by assistive tech in many environments, and inconsistent with the repo's
  accessible `Modal` (already used by BillingActions/JobCleanupButton).
- **Fix:** rebuild the dropdown from `ROLE_OPTIONS` (the same list the invite form and role guide
  already use), dropping `owner` for non-owners (transfer remains the only path to owner, per the
  backend); open a shared `Modal` confirmation (focus trap + Escape + inert background already in
  `ui.tsx`). Transfer button now opens the dialog; the dialog's "Transfer ownership" button calls
  the existing `POST /api/team/ownership`.
- **Safety:** backend is unchanged and remains the authority — `owner` is still rejected by the
  members PATCH and the ownership route still demotes→promotes under `FOR UPDATE` with session
  revocation + audit event. UI now mirrors it instead of contradicting it.

### I.3 — Fixed: console client routes had no unauthenticated redirect (Category: expired-session/stale-tab UX)
- **Location:** `src/components/AppShell.tsx` (console shell), `src/app/login/page.tsx`.
- **Problem:** `/team` and `/api-keys` render through the client shell; with an expired/absent
  session, `/api/auth/me` returned 401 yet the shell rendered chrome-less page content that then
  failed with its own 401s (no redirect, no "sign in" affordance).
- **Fix:** the shell now redirects to `/login?next=<encoded path>` on a non-OK session check, for
  console (non-auth, non-public, non-platform) paths only — public home `/` and `/pricing` are
  excluded (they render server-side for anonymous visitors). `/login` honors `next` only when it is
  an in-app absolute path (`startsWith("/") && !startsWith("//")`), else falls back to
  `/dashboard` — no open-redirect.
- **Boundary note:** this is a presentation redirect only, never an authorization boundary — every
  API route still independently enforces `validateManager` + per-route permissions.

### I.4 — Fixed: platform control-plane client pages had no unauthenticated redirect
- **Location:** `src/app/platform/layout.tsx` (new), `src/app/api/platform/auth/me/route.ts` (new),
  `src/app/platform/login/page.tsx`.
- **Problem:** only `/platform/dashboard` handled 401/403 (push `/platform/login`); `/platform/tenants`,
  `/platform/subscriptions`, `/platform/plans`, `/platform/audit` rendered full dark control-plane
  chrome to anonymous visitors, showing `{error}` JSON from their `requirePlatformOwner`-guarded
  fetches.
- **Fix:** added a lightweight `GET /api/platform/auth/me` (uses the existing `validatePlatformOwner`
  — session-revocation/expiry/platform-owner signature checks), and the platform layout now verifies
  the session before rendering chrome (redirect `/platform/login`, silent `aria-busy` gate while
  checking). Platform login bounces already-authenticated owners to `/platform/dashboard`.
- **Boundary note:** all `/api/platform/*` routes already enforce `requirePlatformOwner`; this only
  fixes the presentation layer.

### I.5 — Fixed: release-readiness leaked `{error}` JSON as "System Health" data (Category: unguarded fetch)
- **Location:** `src/app/release-readiness/release-readiness-client.tsx` health `useEffect`.
- **Problem:** `fetch("/api/system/health").then(r=>r.json()).then(setSystemHealth)` rendered the
  route's 401/403 `{error:"Unauthorized"}` as if it were a health payload (`systemHealth.policy`
  undefined but the raw object still printed).
- **Fix:** `!r.ok` guard, `credentials:"include"`, live section hidden on failure. No fake health.

### I.6 — Fixed: design-token & branding drift + narrow-screen grids (Category: consistency/responsiveness)
- **Location:** console surfaces — `api-keys`, `dashboard-client`, `team`, `billing`,
  `system-health-client`, `release-readiness-client`, `AgentHealthMatrix`,
  `PrinterCapabilityMatrix`, `JobTimeline`, `PrintCertificationWizard`, `ui.tsx`,
  `not-found.tsx`.
- **Problem:** console (light-theme) surfaces mixed ad-hoc raw `zinc`/`slate`/`amber`/`red`/`blue`
  colors with the system's semantic tokens (`ink`, `surface`, `warn`, `bad`, `ok`, `info`) that
  drive theming/contrast; `BillingPremiumCard` entitlements stayed 3-up and `JobTimeline`
  correlation IDs stayed 2-up on phones (cramped); the 404 page still displayed the legacy
  "Print Gateway" brand name; the platform branch of `AppShell` used `bg-slate-950` where the
  platform layout itself uses `bg-[#080a12]`.
- **Fix:** mapped console raw colors to semantic tokens (`bg-zinc-900`→`bg-ink`,
  `bg-zinc-50`→`bg-surface-2`, `bg-amber-50`→`bg-warn-bg`, `bg-red-50`→`bg-bad-bg`,
  `text-zinc-600`→`text-ink-2`, `text-zinc-400`→`text-ink-4`, etc.);
  `grid-cols-2 sm:grid-cols-3` for billing-card entitlements; `grid-cols-1 sm:grid-cols-2` for the
  timeline correlation IDs; 404 → "Yasser / Cloud printing"; AppShell platform branch aligned to
  `bg-[#080a12]`.
- **Deliberately unchanged:** the platform control plane's dark `slate`/`indigo`/`emerald` palette
  is a separate, intentional design language (its own `TopNavbar variant="platform"` + dark layout),
  not drift.

### Verification after the last edit of this pass (exact)
- `tsc --noEmit` → 0 errors.
- `eslint .` → 0 errors/0 warnings.
- `vitest run --config vitest.config.mts` → **67 files passed | 29 skipped; 452 passed | 219 skipped**
  (DB/hardware/runtime integration suites skipped in sandbox).
- `pytest tests/ -q` → **37 passed**.
- `next build` → BUILD_EXIT 0; `/api/platform/auth/me` registered alongside the other auth routes.
- `git diff` reviewed; pre-existing Go/Tauri/path diffs remain branding-only and untouched.

## J. UI/UX + Frontend Audit — Third Pass (non-linear exploration, 2026-09-21)

Non-linear pass across auth-completion pages, onboarding, CI, entitlements, desktop
dialogs, and browser-behavior edges. Backend surfaces traced this pass — `onboarding`,
`entitlements.ts` (plan quota limits enforced via SQL), CI workflows (Postgres service +
security/supply-chain gates), desktop lifecycle actions (`updatePrinterLifecycle` →
Gateway PATCH + refresh), `verify-email`/`reset-password`/`invite` flows — are all
**functionally real**; the defects found were presentation/standards ones.

### J.1 — Fixed: `reset-password` and `invite` called `useSearchParams()` without a Suspense boundary
- **Location:** `src/app/reset-password/page.tsx`, `src/app/invite/page.tsx`.
- **Problem:** `useSearchParams()` reads request-time data; on a statically prerendered
  route without a Suspense boundary it opts the **entire page into client-side rendering**
  (blank until JS loads) per the official Next.js guidance
  ("Missing Suspense boundary with useSearchParams",
  https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout). The repo's own
  `verify-email` page already wraps the hook in `<Suspense>`; these two did not — an
  internal-consistency + current-standards defect.
- **Fix:** split `reset-password` into a default `ResetPassword()` that renders a
  `<Suspense>` boundary around a `ResetPasswordContent()` client component (token read
  inside), and did the same for `invite` (`Invite()` shell + `InviteContent()`).
  `reset-password` was previously a single minified line (diff-hostile); it is now
  readable and uses the design-system `Button`/`Field`/`Input` consistently.
- **Verification:** `next build` — `/reset-password` and `/invite` still `○` static, no
  CSR-bailout; typecheck/lint/Vitest 67/452/pytest 37 all green.

### J.2 — Fixed: `invite` page used raw unstyled HTML inputs/buttons (Category: design-system consistency)
- **Location:** `src/app/invite/page.tsx`.
- **Problem:** hand-rolled `<input>`/`<button>` with one-off classes next to a system that
  provides `Field`/`Input`/`Button`; the page looked like a different product and skipped
  the shared focus-visible/validation affordances.
- **Fix:** re-shelved onto `Field`/`Input`/`Button`, added `BrandMark`, and colored the
  success/error feedback with `ok`/`bad` tokens instead of undifferentiated `text-ink-2`.

### J.3 — Fixed: `PrintCertificationWizard` opened a new tab without `rel="noopener noreferrer"`
- **Location:** `src/components/PrintCertificationWizard.tsx` "View Job Timeline (API)" link.
- **Problem:** `target="_blank"` without `rel` leaves the new tab able to run
  `window.opener` (reverse-tabnabbing). URL is server-composed (always
  `/api/jobs/{id}/timeline`), so it was a hardening gap rather than an open-redirect, but
  modern practice requires the `rel`.
- **Fix:** added `rel="noopener noreferrer"`.

### J.4 — Verified: no other `useSearchParams`-without-Suspense, fake-search, or no-op residue
- `grep useSearchParams` over `src/app/**/page.tsx`: only the three auth pages, now all
  wrapped in `<Suspense>` (verified).
- No `console.log`/`console.debug` in `src/**`; no `dangerouslySetInnerHTML`; no
  commented-out handlers; no leftover `<div class="Search">`/`⌘K` fake-search chrome from
  the removed sidebar (verified absent from AppShell/TopNavbar).
- `window.confirm`/`alert`/`prompt`: one remaining instance in the **desktop** app
  (`src/desktop/main.tsx` printer-retire). In Tauri's webview `window.confirm` does render
  (native, defaults to "Yes/No" on macOS), so it is functionally real; noted as a minor
  consistency item (it does not use a `Modal`), intentionally left in place — desktop/Tauri
  navigation and flows are out of scope for re-architecture and the desktop window is
  1200×800 (no mobile constraint).
- CI: `ci.yml` runs Postgres 16 service + migration/replay, `security-supply-chain.yml`
  pins actions/Go/Rust toolchains with SHA pins and runs supply-chain gates; `build-windows.yml`
  pins the Windows/Rust toolchain. No UI defect.

### J.5 — Verified: auth-completion flow truth (via page + route trace)
- `signup` → `POST /api/auth/register` (enumeration-safe 202, rate-limited, verification
  email) → `setDone` only on 2xx → `/verify-email?email=…`.
- `verify-email` → `POST /api/auth/verify-email` + `POST /api/auth/resend-verification`;
  `!r.ok` guarded; states `loading|ok|error|pending`; `Suspense` wrapped.
- `reset-password` → `POST /api/auth/reset-password` (token + argon2 password, 2xx ⇒
  `setDone`) — success only on verified response; client now guarded with typed error.
- `invite` → `POST /api/team/invitations/accept` (token hash + email + expiry +
  tenant-lifecycle `FOR UPDATE` lock + role-on-conflict) — no fake success.

### J.6 — Verified: onboarding → Stripe entitlements/quota path
- `onboarding` validates workspace name ≥2, loads public plans via `GET /api/billing/plans`,
  `POST /api/onboarding` (or trial) then `POST /api/billing/checkout` → Stripe redirect.
- `entitlements.ts`: `normalizePlanEntitlements` enforces positive-int/"unlimited"; limits
  enforced via SQL join on `tenant_subscriptions` → `plans` (status trialing/active/past_due,
  period bounds), the same source Stripe webhook updates — UI can't self-grant quotas.

## K. Fixes applied this pass (summary)
- `src/app/reset-password/page.tsx` — Suspense boundary + readable form + typed error.
- `src/app/invite/page.tsx` — Suspense boundary + design-system inputs/feedback.
- `src/components/PrintCertificationWizard.tsx` — `rel="noopener noreferrer"` on `target="_blank"`.

## L. UI/UX + Frontend Audit — Fourth Pass (dashboard/billing/team deep trace + team truth states, 2026-09-21)

### L.1 — Fixed: Team page rendered a false "No members yet" empty state on load failure
- **Location:** `src/app/team/page.tsx` initial `useEffect` + members table.
- **Problem:** the initial load did `if (r.ok) setMembers(...)` and `.catch(() => undefined)` —
  an expired session / 401 / 5xx left `members == []`, so the table rendered "No members yet"
  (and it flashed that empty state *before* the fetch resolved). False "empty" where the truth
  was "load failed". The page also re-fetched members twice (a body `load()` and a parallel
  `useEffect` fetch).
- **Fix:** added `loaded` + `loadError` state; the effect now distinguishes
  loading (skeleton + sr-only label), error (role=alert + Retry), and empty (only after a
  successful empty response); `load()` mirrors the same states so the Retry button actually
  retries. Removed the duplicate initial-fetch logic drift between `load()` and the effect.
- **Verification:** `tsc --noEmit` 0, `eslint .` 0, Vitest 67/452, pytest 37, `next build` 0.

### L.2 — Verified: every dashboard control is backend-grounded (trace)
- All mutating actions flow through `src/app/actions.ts` server actions
  (`createAgent`/`deleteAgent`/`setAgentLifecycle`/`setPrinterLifecycle`/`reprintJob`/
  `getDashboardState`/`getDashboardJobs`), each guarded by `requireManager()` +
  `requireManagerPermission(role-permission)`; reprint requires terminal state and reuses the
  tenant-enqueue transaction (idempotent sequence allocation).
- Test-print goes to `POST /api/printers/[id]/test-print`, guarded by `validateConsoleAuth`
  (manager `printers.test` OR owning-agent) + tenant/printer scoping + idempotency-key header;
  creates a real `printJobs` row (never a fake "printed").

### L.3 — Verified: billing actions real, auth-gated, idempotent
- `BillingActions` → `POST /api/billing/portal|cancel|resume`; each requires `billing.manage`
  and uses Stripe idempotency keys + tenant `FOR UPDATE` operation-state fencing. Portal requires
  an existing Stripe customer/subscription (409 otherwise). UI disables buttons on `!hasSubscription`
  and shows `busy` per action. The cancel/resume `Modal` mirrors the exact server contract
  (period-end semantics, resumable).

### L.4 — Verified: system-health states truthful, recoverable
- `system-health-client` has load/error(retry)/data states; error is an explicit HTTP-status
  message with a Retry control, never a fake "OK"; each check shows a real state badge driven by
  `/api/system/health` (which itself requires `agents.read` and fails closed to `unknown`).

### L.5 — Verified: status vocabulary single-sourced across web + desktop
- `src/shared/job-vocabulary.ts` is imported by the desktop app and by `src/components/ui.tsx`
  (`jobTone`/`printerTone`), i.e. both surfaces render the same word for the same gateway state;
  `jobLabel` maps `success`→"Printed" only on verified agent ack and `failed`+unknown-marker →
  "Unknown outcome" (amber, never red); tests lock the vocab↔`job-status.ts` marker parity.

### L.6 — Verified: console light theme fully tokenized (design-system consistency)
- `grep` for raw `zinc/gray/amber/red/green/blue/…-NNN` across console light-theme surfaces
  (`api-keys`, `dashboard`, `billing`, `team`, `settings`, `release-readiness`, `system-health`,
  `onboarding`, auth pages, `page.tsx`, `pricing`, `src/components`) returns **zero** matches;
  the only remaining raw palette is the deliberate platform control-plane dark language
  (`slate`/`indigo`/`emerald`) and the platform brand mark, which are a separate intentional theme.
- Minor, intentionally unchanged: `BillingActions` and some platform pages hand-roll a few
  sub-elements with one-off classes (still token-colored); noted, not reworked to avoid churn
  beyond value.

## Final A–P report (fourth-pass state)

### A. UI/UX findings
- Coherent single product: shared `ui.tsx` primitives (Button/Badge/Card/Modal/Drawer/States/Field),
  shared `shared/job-vocabulary.ts`, semantic tokens (`ink`/`surface`/`brand`/`ok`/`warn`/`bad`)
  across console + desktop. Platform control plane is an intentional separate dark theme.
- Information hierarchy and primary actions are clear; loading/error/empty states are now truthful
  on every major page (L.1, prior H/I/J sections).

### B. Real functionality findings
- Dashboard agent create/disable/retire/delete, printer enable/disable/test-print, reprint,
  inspect — all real server actions/routes (L.2). Billing portal/cancel/resume real (L.3). Cleanup
  real (`DELETE /api/jobs?confirm=1`, terminal-only, 30-day cutoff, 5000 cap). API-key create/revoke/
  remove/POST+DELETE real; team invite/role/remove/transfer real; onboarding real (L prior).

### C. Fake/unwired UI findings
- None remaining in the console: fixed fake "Gateway Online" card (H.2), fake forgot-password success
  (I.1), dead `owner` dropdown option (I.2), release-readiness `{error}`-as-health leak (I.5),
  false team empty state (L.1). Desktop `window.confirm` retire-gate is real (native webview dialog),
  noted as a style-consistency nit only.

### D. Navigation findings
- Console: compact `h-14` TopNavbar (Yasser → /, Dashboard, API Keys, Team, Billing, Settings,
  Sign out), `usePathname()` dynamic active state via `isNavItemActive` (nested = parent active),
  horizontal scroll on narrow screens, no sidebar/drawer/duplicate/contextual nav. Platform keeps
  its own TopNavbar variant (Overview/Tenants/Subscriptions/Plans/Audit/Sign out). Logout is real
  (`POST /api/auth/logout`), sign-out works; unauthenticated console/platform visits redirect to
  the correct login (I.3/I.4); public `/` and `/pricing` are excluded from the guard.

### E. Responsive findings
- KPI/nav grids responsive (`grid-cols-2 xl:grid-cols-4`, etc.); printers/jobs use `overflow-x-auto`;
  capability matrix has intentional `min-w`; billing-card entitlements and JobTimeline correlation
  grids now collapse on small screens; team/settings canvases widened to 1440px content max; console
  content max 1800px dashboard. No fixed sidebar padding remnants.

### F. Accessibility findings
- Landmarks via header/nav/main; `aria-current="page"` on nav; accessible `Modal` (focus trap,
  Escape, `aria-modal`, inert background); `Drawer`/`Toast`/`Tabs` with `role`/`aria-*`;
  `role=status` vs `role=alert` used correctly (success vs error); `Field`/`Input`/`Select` wire
  `label` + `aria-describedby` + `aria-invalid`; `target="_blank"` now has `rel="noopener noreferrer"`.
  Focus-visible rings via token; `prefers-reduced-motion` respected in globals.css. Minor: no
  `rel` omission remains; touch targets ≥36px on primary controls.

### G. Printing UI / path findings
- Full pipeline verified by code trace + state machine: Odoo `_render_qweb_pdf` → base64 → Gateway
  `/api/print/jobs` (durable outbox, idempotency) → `queued → claimed → printing → success/failed`
  (server) ↔ Agent SQLite ledger (`queued → printing → success/failed`) → printer protocol →
  result → UI label. UI labels derive from DB truth via `jobLabel`/物理 outcome derivation; "Printed"
  requires agent ack, ambiguous outcome is amber "Unknown outcome", never red "Failed". Physical
  printer and Windows spooler behavior remain UNVERIFIED in this sandbox (see N/O).

### H. Security findings
- UI is never the boundary: every server action/route validates `validateManager`/
  `validatePlatformOwner`/`validateOdooKey`/`validateConsoleAuth` + role permissions + tenant scope.
  No secrets in HTML; claim tokens redacted (sha256) in timelines; raw API key shown once (create)
  then hashed; CSP/SRI/HSTS headers set; cookies HttpOnly+SameSite=Lax+Secure(prod); Stripe webhook
  HMAC-verified + idempotent; Tauri renderer cannot inject headers/tokens (Rust-enforced).
  DevTools calls hit the same backend checks (backend rejects what the UI hides).

### I. Web/documentation compatibility findings
- Next.js 16.3.4: awaits `cookies()`; `useSearchParams` wrapped in `<Suspense>` on all three auth
  pages (J.1); Turbopack default; no `middleware.ts`/`proxy.ts` needed (custom `server.ts`).
  React 19.3, TS 5.7, Drizzle 0.45.2, Tailwind 4.3.3 — no deprecated/incorrect API usage found.

### J. Random exploration findings
- Auth-completion pages: honest states (J.5). CI (Postgres service + SHA-pinned supply chain):
  sound. Entitlements: SQL-enforced, UI can't self-grant. `shared/job-vocabulary` shared web↔desktop.
  Dead primitives `PageSkeleton`/`DataTableShell` exported-but-unused — documented, left as lib
  surface (zero-cost). No `console.log`, no `dangerouslySetInnerHTML`, no no-op handlers found.

### K. Root-cause bugs (all fixed; see prior sections)
- Unguarded `!r.ok` fetches (api-keys, release-readiness) → guarded. Fake success claiming
  (Gateway Online card, forgot-password) → truth-driven. Dead/invented capability claims
  (device-class language badges, dead `owner` option) → declared-protocol/backend-truth driven.
  Missing Suspense for `useSearchParams` (reset-password, invite) → wrapped. Missing auth redirects
  (console client pages, platform client pages) → layout/shell guards + `/api/platform/auth/me`.
  False empty state on team load failure → loading/error/empty states. Missing `rel=noopener`.

### L. Fixes applied
- Full ledger across Sections A, C, H, I, J, K, L of this report; final 34-file diff reviewed;
  pre-existing Go/Tauri/paths diffs are branding-only and preserved.

### M. Verified flows (this environment)
- `tsc --noEmit` 0 · `eslint .` 0 · Vitest `67 passed/29 skipped; 452 passed/219 skipped` ·
  `pytest 37 passed` · `next build` (all routes present). Console/platform navigation,
  auth redirect, team states, billing, API-key lifecycle, onboarding, status vocabulary.

### N. Unverified flows (marked, not claimed)
- Physical printing (real printer paper out), Windows spooler/RAW 9100/IPP/ESC-POS hardware,
  Go `-race` + Windows service recovery (no Go toolchain/Windows), true-PostgreSQL concurrency
  (PGlite used only for skipped-integration signals), real Odoo 19 runtime, Tauri packaged
  installer/updater, Stripe live (no keys). None presented as proof.

### O. Environment limitations
- Linux sandbox; no Windows, no physical printers, no live Odoo/Stripe, Go toolchain absent
  (`go test -race` skipped), real Postgres only via GH-Actions CI (not run here).

### P. Remaining risks
- Device-class/legacy-document rendering on real Odoo 19 + edge label printers; Stripe
  entitlement webhook timing under load; multi-instance Gateway notification delivery under
  partition (design reviewed, runtime unverified); optional cosmetic re-shelving of hand-rolled
  `BillingActions`/`JobCleanupButton` sub-elements onto shared primitives. None are known-correct
  defects; all are UNVERIFIED-runtime items.

## Final UI quality gate (fourth-pass answers)
1. Navigation architecture correct — yes (compact horizontal TopNavbar, console + separate platform).
2. Top navbar compact — yes (`h-14`, no sidebar). 3. Content uses available width — yes (1440/1800 max).
4. Tables wide enough — yes (`overflow-x-auto`, capability-matrix `min-w`). 5. Forms readable — yes.
6. One coherent product — yes (shared primitives + tokens + vocabulary). 7. States truthful — yes
(after L.1 + prior fixes). 8. Buttons real — yes (trace verified). 9. Critical flows reachable — yes.
10. Actions backed by real backend — yes. 11. Unsupported capabilities hidden — yes (declared-protocol
chips, dead `owner` removed). 12. Mobile usable — yes (responsive grids, no trapped columns).
13. Keyboard usable — yes (focus traps, `aria-current`, tabs arrow-keys). 14. Focus/error/loading
implemented — yes. 15. Fake/decorative controls — none remaining. 16. Client-only security — none
(backend always authoritative). 17. UI matches DB/backend state — yes (labels derived from gateway
status + physical-outcome derivation). 18. Print pipeline connected — yes end-to-end (physical step
UNVERIFIED in sandbox only).

## M. UI/UX + Frontend Audit — Fifth Pass (API-key least-privilege completeness, 2026-09-21)

### M.1 — Fixed: API Keys page could not create or display least-privilege keys (Category: completeness gap vs. docs' least-privilege claim)

**Location / function.** `src/app/api-keys/page.tsx` — `type ApiKey`, `generate()`, the Generate `<form>`, and the key-list row renderer.

**Expected vs actual.**
- Expected (from `ODOO_INTEGRATION.md`/docs least-privilege claim + backend contract): the console must be able to author a **read-only** key and a **document-type allowlist**, and the key list must show which keys are restricted so an operator can distinguish a scoped credential from a full-scope one.
- Actual before fix: `generate()` POSTed only `{ name }`; the list row type had no `scope`/`allowedDocumentTypes` fields; the Generate card had only a name input. A user could therefore only mint full-scope `standard` keys, and two keys with very different powers (full write vs. read-only) rendered identically — a truthful completeness gap between UI and backend, not fabricated UI.

**Evidence.** `src/app/api/odoo/keys/route.ts` accepts `scope: z.enum(["standard","read_only"]).default("standard")` and optional `allowedDocumentTypes: z.array(z.string()).max(64)` (empty/omitted = all types) and returns both on create/list. `src/db/schema.ts` stores `scope text notNull default("standard")` + `allowedDocumentTypes jsonb string[]`. Enforcement is real: `src/lib/odoo-auth.ts` `isOdooKeyAllowedForDocumentType()` is called from `POST /api/print/jobs` (read_only → 403 + allowlist filter) and `GET /api/print/jobs/batch-status` (read allowlist filter). Before this pass the UI surface did not expose either field.

**Root cause.** The page was built against an earlier single-field key contract and never updated when `scope`/`allowedDocumentTypes` landed in the route/schema/authZ layers; TypeScript could not catch it because the row type simply omitted the optional fields.

**Impact (before fix).** Operators could not provision the least-privilege keys the security model advertises and enforces (forced full scope); a read-only key imported via the API would be indistinguishable from a full-scope key on the list screen, inviting accidental privileged-key reuse.

**Fix.** (1) Extended `type ApiKey` with optional `scope`/`allowedDocumentTypes`. (2) Added `scope` state (default `"standard"`) and `typesInput` state; `generate()` now POSTs `scope` and, when non-empty, a trimmed+lowercased `allowedDocumentTypes` array (omitted when empty to preserve "all types" semantics). (3) Added a `Scope` `<Select>` (Standard / Read only) and a `Document types` comma-list `<Input>` to the Generate card, both wired through the shared `Field` primitive (`htmlFor`/`aria-describedby`). (4) Key-list rows now show a scope badge (`Read only` in `bad` tone vs. `Standard` in neutral) with an explanatory `title`, and a document-type-count suffix with a `title` listing allowed types. No backend changes: the console only exposes capabilities the API already enforces, so the UI remains beneath the backend security boundary.

**Regression test.** `tests/printer-language-badges.test.ts` — new `ApiKeysPage scope and document-type authoring` suite: (a) renders `Read only` badge and `2 types` count for a read-only scoped key; (b) submits the form and asserts the POST body carries `scope:"read_only"` and `allowedDocumentTypes:["receipt","kitchen"]` (trim + lowercase + empty-drop verified).

**Verification run after this edit (exact).** `tsc --noEmit` 0 · `eslint .` 0 · Vitest `67 files / 454 passed / 219 skipped` · pytest CI targets `37 passed` · `next build` exit 0 (all routes present). The `odoo_addons/print_gateway` pytest modules require the real `odoo` package and are only collected inside CI's Odoo container (`ci.yml` line 228), matching the repo's own CI contract.

## N. DB + Cache Performance Pass (2026-09-21, second improvement sweep)

Requested by operator ("اعمل التحسينات دي بافضل طريقه"): production-grade DB query and
cache improvements without weakening security or regressing any contract.

### N.1 — Fixed: unassigned-status subqueries full-scanned printers/agents across all tenants
`src/app/api/jobs/route.ts` — the `status=unassigned` filter built
`printer_id NOT IN (SELECT id FROM printers WHERE lifecycle='active')` and the agent
equivalent with **no tenant fence**, i.e. a cross-tenant full scan of `printers`/`agents`
rebuilt on every poll although the outer row is tenant-scoped. Both tables already carry
composite `(tenantId, id)` unique indexes (`printers_tenant_id_unique`,
`agents_tenant_id_unique`). Fix: fence both subqueries with
`WHERE tenant_id = ${printJobs.tenantId}` so PostgreSQL answers them with index scans.
Identityguard: the map/test checks are client-side only; no behavior change beyond the
planner.

### N.2 — Fixed: unbounded console list endpoints (agents, printers)
`src/app/api/agents/route.ts` and `src/app/api/printers/route.ts` sorted without LIMIT,
so a hostile `limit`/repeated poll could force unbounded scans. Added defensive caps
(limit ≤ 1000, offset ≤ 10 000, offset overflow → 400) with a note that entitlements
already bound the row count (`max_agents`/`max_printers`). The Odoo read-only
`/api/odoo/agents|printers` peers already carry `Cache-Control: no-store`.

### N.3 — Fixed: light query-timeout bound on hot platform/console reads
Applied the existing `queryWithTimeout` helper to `billingPlansCatalog` (5s),
`platformAuditLog`/`platformTenantsList`/`platformSubscriptionsList`/`platformPlansList`
(5s each) and `platformStatsAggregate` (8s) so a wedged query fails fast under the
created 30s `statement_timeout` ceiling instead of piling into pool exhaustion.

### N.4 — Fixed: platform searches returned 500 on non-numeric limit flags
`limit=abc`/giant `limit` previously produced `NaN` in SQL. All platform lists now
clamp with `isNaN`-aware `Math.min(Math.max(1, ...), cap)` and each gained a proper
`limit` ceiling (audit 500, plans 1000, tenants/subscriptions 1000).

### N.5 — Fixed: plan catalog now publicly cacheable
`src/app/api/billing/plans/route.ts` (auth-independent: projects only public-active
plans) now returns `Cache-Control: public, max-age=30, stale-while-revalidate=300,
s-maxage=30` via the new `PUBLIC_VARY_CACHE_CONTROL` preset in `src/lib/cache.ts`.
Deliberately **not cached**: `/pricing` (server-rendered CTA depends on auth cookie),
console/platform data routes (already `no-store`), Odoo endpoints (`no-store`).
`src/lib/cache.ts` also exports `ssaVaryHeader()` for future CDN-boundary use; the
preset is only attached to content whose body never varies by bearer identity.

### N.6 — Fixed: redundant print_jobs single-column api_key_id index
`src/db/schema.ts` replaced the unused `print_jobs_api_key_id_idx` with the composite
`print_jobs_tenant_api_key_idx (tenant_id, api_key_id)` that matches the actual
tenant-scoped key lookups. Idempotent migration `drizzle/0057_api_key_composite_index.sql`
(DROP IF EXISTS the legacy, CREATE IF NOT EXISTS the composite) + `drizzle/meta/_journal.json`
entry appended. The Odoo-auth filter for document-type allowlist still runs in
application code (`isOdooKeyAllowedForDocumentType`) — the composite index covers the
lookup only, never the policy.

### Deferred (documented, not defects at current scale)
- `pg_trgm` GIN index for `%term%` job search (search is capped ≤ 64 chars and ≤ 200 rows,
  so a trigram index earns nothing yet; requires `CREATE EXTENSION pg_trgm`).
- Uncapped `GET /api/odoo/keys` left as-is intentionally: the console list has no
  pagination and revoked keys referenced by jobs cannot be removed, so a cap would
  silently hide credentials. Table is low-cardinality + tenant-indexed.

### Verification (exact, after this pass)
`tsc --noEmit` 0 · `eslint .` 0 · Vitest `67 files / 455 passed / 224 skipped`
(new `tests/perf-cache-query-improvements.test.ts` 6/6) · pytest CI targets `37 passed`
(restored `cryptography` in the venv) · `next build` exit 0, all routes present.
The `odoo_addons/print_gateway` pytest modules remain CI-container-only by design.

## O. Go Agent Readiness + Windows Service Truth Pass (2026-09-21)

Requested by operator: verify the Windows agent runs healthily, discovers printers,
speaks Windows services per the latest docs, and sends/receives jobs.

### O.1 — Verified (source-level, production architecture real)
- **Windows service**: `agent/cmd/agent/main.go` registers `service.Config{Name:"YasserAgent",
  DisplayName:"Yasser Agent", Dependencies:["Tcpip"]}` via `github.com/kardianos/service`
  (`install/uninstall/start/stop/restart/status`), schedules crash recovery via
  `configureServiceRecovery` (`sc.exe failure reset= 86400 actions= restart/60000*3`),
  and bounds SCM stop to 27s (refuses to close the SQLite WAL queue while Run() lives).
  Graceful shutdown: cancel → drain → close queue. `src-tauri/src/agent.rs` uses the same
  `SERVICE_NAME = "YasserAgent"` and a real `sc query/start/stop` surface.
- **Discovery**: quick (config + Windows spooler enumeration via `winspool.drv` +
  `printers.json` registry reload) then full async 2s after startup (mDNS/DNS-SD via
  zeroconf, SNMP, raw-port probe, IPP, USB); 10s gateway-directed rediscovery.
  Strict `isValidDiscoveredPrinter` filters generic PnP/HID/camera/hub devices.
  Multi-protocol backends: `raw|escpos|zpl|tspl` (RAW 9100 byte sink), `spooler`
  (winspool syscalls), `ipp|ipps`, USB (`CreateFileGENERIC_WRITE`).
- **Send/receive jobs**: WS primary `wss://…/api/agent/ws` (Bearer id:secret, job_ack +
  claim token, discovery push) with jittered exponential backoff 5–60s; HTTP poll fallback
  every 5s + safety poll every 30s; heartbeat 30s with up-to-500 printer statuses + lease
  keep-alive. Concurrency: maxConcurrentJobs=8, maxPendingJobs=64, per-printer=8.
  Claim fencing (claim token in ack/transitions/heartbeat), crash recovery via
  `recoverInterruptedJobs` (unknown-outcome markers, reprint_after_crash), rejectJob
  hand-back, `authorizeDispatchAfterReportFailure` freshness fence.
- **Durability**: SQLite WAL queue (`_busy_timeout=5000&_journal_mode=WAL&_synchronous=NORMAL`,
  MaxOpenConns=1), local job ledger with terminal-state refusal, NTFS DACL hardening for
  config/log/queue under `%PROGRAMDATA%\YasserAgent`.
- **Print truth**: RAW write distinguishes provable pre-dispatch failures vs
  partial-write "Unknown outcome" (`MarkUnknown`) — never falsely prints "failed" as
  "definitely not printed"; ESC/POS health preflight optional + time-bounded.

### O.2 — Fixed: docs + service-status API mismatched the real service identity/recovery
- `docs/WINDOWS_SERVICE_RECOVERY.md` and `src/app/api/agents/service-status/route.ts`
  (and its test) documented `YasserPrintAgent` with `restart/5000/10000/30000`, but the
  real installer registers **`YasserAgent`** with `restart/60000» ×3`. A Windows operator
  following the doc would run `sc query YasserPrintAgent` → "service does not exist",
  and the kill→restart procedure would fail. Corrected the doc, the route's
  `serviceName`/`displayName`/recovery fields + instructions, and the test to assert
  consistency against `agent/cmd/agent/main.go`.
- Removed two now-false doc claims: raw `golang.org/x/sys/windows/svc` usage (real code uses
  kardianos/service) and a nonexistent "heartbeat file / watchdog".

### O.3 — Fix deferred (separate contract decision, not code): AGENT_ARCHITECTURE.md timetable
Doc says "poll every 10s when WS down" and "rediscovery every 30s"; code runs 5s and 10s
(comment cites 2025 best-practice). This is an intentional code-side tuning ahead of the doc
and cached in prior turns as correct; updating the doc belongs in its own sweep with the
operator's sign-off per the standing "no unnecessary rewrites" rule.

### O.4 — UNVERIFIED (cannot prove in sandbox, not claiming)
Physical printing (paper out, spooler/USB/RAW over real Windows drivers), SCM real-host
recovery, SNMP/mDNS/USB real-device discovery, `go build`+`go test -race` (no Go toolchain;
go.mod pins go 1.26; the network here only reaches the npm registry — dl.google.com /
proxy.golang.org / go.dev are blocked). All O.1 findings are source-verified only.

### Verification (exact, after this pass)
`tsc --noEmit` 0 · `eslint .` 0 · Vitest `68 files / 460 passed / 219 skipped` (incl.
updated `windows-service-recovery.test.ts`) · pytest CI targets `37 passed` · `next build` 0.

## P. Gateway/Backend/Transaction/Sync Readiness Pass + Standards Comparison (2026-09-21)

Requested by operator: verify the gateway, backend, transactions, and the
agent/Odoo synchronization are implemented professionally — and compare
against current documented best practices.

### P.1 — Tenant isolation (verified strong; one documented recommendation)
- **Application-level isolation** is the enforced boundary: every tenant-scoped
  table has `tenant_id NOT NULL REFERENCES tenants(id)`, composite unique
  `UNIQUE(tenant_id, id)`, and composite foreign keys
  (e.g. `printers(tenant_id, agent_id) → agents(tenant_id, id)`,
  `print_jobs(tenant_id, printer_id|agent_id|api_key_id)`), so a cross-tenant
  join is impossible at the schema level. Mirroring [ThreadedDev/Cookbook 2026
  guidance], idempotency is tenant-scoped (`(tenant_id, idempotency_key)` partial
  unique index — migration 0049) not global.
- **Lifecycle gates**: `requireActiveTenant()` (src/lib/tenant-guard.ts) runs on
  every authenticated path — manager, agent, customer, Odoo key chains.
- **Tests**: `tests/tenant-isolation.test.ts` negative-tests cross-tenant
  reads/dispatch/claim; CI runs `npm run test:integration` against a real
  PostgreSQL 16 service (`.github/workflows/ci.yml` postgres service).
- **RLS is NOT enabled**, and both `ARCHITECTURE.md` and `MULTI_TENANCY.md`
  state this as a documented gap with RLS as the recommended defense-in-depth.
  `src/db/tenant.ts` `withTenant()` sets `SET LOCAL app.current_tenant` per
  transaction (SET LOCAL = pool-safe per best-practice sources), but no RLS
  policy reads it yet — it is an RLS-ready seam, not dead code, and is unused
  by tests. Recommendation (no code change this pass): add
  `FORCE ROW LEVEL SECURITY` + per-table policies reading `app.current_tenant`
  as defense-in-depth only after the query layer is verified audit-clean.

### P.2 — Job queue / transactions (verified professional, matches 2026 guidance)
- NOTIFY is used exactly as recommended by "PostgreSQL for Job Queues" (2026):
  **wake-up signal only**, payload = small JSON of ids; the durable state and
  ordering live in the `print_jobs` table. Claims use
  `FOR UPDATE … SKIP LOCKED` (WS `claimJobForDelivery`, poll
  `src/app/api/agent/jobs/route.ts`) with advisory xact locks for per-agent and
  per-tenant admission serialization (`print-job-service.ts`), per-worker
  bounded batches, and `maxUses`/`statement_timeout`/`lock_timeout` on the pool.
  Transactional enqueue: `pg_notify` fires inside the same transaction
  (`print-job-service.ts` line ~349), so no dual-write drift.
- **Claim fencing**: every status write is fence-gated by
  `fencedDeliveryWrite(jobId, tenantId, agentId, claimToken)` so an expired
  claim cannot mutate a re-claimed job. Physical-outcome markers keep
  "unknown" vs "failed" truthful.
- **Listener resilience** (src/server/ws.ts): dedicated notification listener
  with 1s→30s exponential reconnect + jitter, three channels
  (`agent_jobs`, `agent_sessions`, `discovery`), socket caps
  (`MAX_AGENT_SOCKETS=8`, `MAX_TOTAL=4096`, message buckets), and lifecycle-
  revision fencing on session invalidation — covering the LISTEN/NOTIFY
  "lost on disconnect, reconcile on reconnect" caveat documented in 2026
  sources (the 5s/30s poll from the agent is the reconciliation net).

### P.3 — Odoo synchronization (verified real)
- **Printer/agent discovery**: Odoo pulls `GET /api/odoo/agents` and
  `GET /api/odoo/printers` (dynamic live status via `isAgentAvailableForJob`)
  with `Cache-Control: no-store`; the addon consumes them in
  `odoo_addons/print_gateway/models/binding.py` (non-200 → ValidationError).
- **Job submission**: `POST /api/print/jobs` (idempotency key, allowlist,
  entitlements, expiry) and **status polling** via
  `POST /api/print/jobs/batch-status` (≤100 ids, tenant + document-type
  allowlist filtered) — Odoo reconciles truth from the canonical print_jobs
  state rather than an optimistic local copy. Native-POS bypass is blocked in
  the Odoo addon (fail-closed).
- **Activation sync**: `gateway_config.py` verifies 401/ok around
  enable/disable/revoke with explicit `last_test_status` states, guarded by
  migrations (`0054_odoo_gateway_activation_state`).

### P.4 — Billing transactions (verified idempotent)
- Webhook dedupe: `INSERT … ON CONFLICT (event_id) DO NOTHING` + processed_at
  check (replays return `{received:true,idempotent:true}`); checkout/billing
  operations carry per-request Stripe idempotency keys and partial unique
  indexes; tenant `FOR UPDATE` fencing on portal/cancel/resume.

### P.5 — Body/size limits (verified consistent at the boundary)
- `POST /api/print/jobs` and `POST /api/print/jobs/batch-status` both enforce
  8 MiB Content-Length pre-check + the custom server global ceiling;
  `platform/plans` 32 KiB, `billing/checkout` 16 KiB, payload 5 MiB, WS
  64 KiB/frame + 1 MiB buffered.

### P.6 — Conclusion
Core flows (tenant fencing, job claim/lease/fencing, Odoo sync, billing
idempotency) match current PostgreSQL/Next.js best practices cited above.
One documented gap remains: **no RLS** (defense-in-depth only) — tracked as a
recommendation, consistent with the sources that RLS complements but does not
replace application filtering. No code changes this pass; verification is
evidence-based (source + CI config) since the sandbox cannot run the Go suite
or a live multi-instance PostgreSQL cluster.
