# AUDIT_EDIT_STATE.md

Branch: `arena/01a0f87e-oddo-print` (branched from `b3459da`, never `main`).
Last updated: 2026-10-01T21:25Z · Last modified file: `src/app/dashboard/dashboard-client.tsx`
(fleet summary grid), `src/app/team/page.tsx` (members table), `src/lib/utils.ts` (`shortId`).

## Current phase

**Phase 5 (validation) complete → final step: push and Pull Request.**
All five phases have been executed; the remaining actions are pushing the branch and
publishing the PR summary.

## Task list

| Status | Task |
| --- | --- |
| done | Phase 1 — repo map, entry points, toolchain inventory, memory files |
| done | Agent — Win32 spooler session correctness (EndDoc vs Abort, BOOL verdicts) |
| done | Agent — bounded two-call `GetPrinterW(2)`, single-flight `Status()`, level-4 `EnumPrintersW` |
| done | Agent — fake-syscall printer tests (no hardware required) |
| done | Agent — race-free Win32 test hooks; accurate partial-byte evidence |
| done | Gateway — verify-email request/redirect ownership (AbortController + timer cleanup) |
| done | Gateway — `docs/DATABASE.md` generated + stdlib drift checker |
| done | Gateway — authentication sweep (76 route files), WebSocket review, N+1 and secret-logging scans |
| done | Tauri/Rust — IPC permission map, CSP, agent process lifecycle review |
| done | Odoo — Python/XML syntax, cron fields, Odoo 19 route types, ACL/record rules, translation markers |
| done | Phase 3 — 3 dead components removed, 4 audit snapshots archived, dead-code/env-var scans |
| done | Phase 4 — verify-email fix; design system audited (EmptyState/ErrorState/LoadingState/focusRing already present and used) |
| done | Phase 4b — user-reported UI defects: stray card borders, clipped team table, meaningless `printer_` id text, airy table rows |
| blocked | Local execution of Go, Rust and Node toolchains — none installed and installing is forbidden (see UNVERIFIED) |
| blocked | Physical printer, Windows service, live Odoo 19 and live PostgreSQL validation |

## Architectural decisions (and why)

1. **Never finalize what was not fully written.** A complete spooler document is
   released with `EndDocPrinter`; an incomplete one is discarded with `AbortPrinter`.
   Releasing a truncated RAW/ESC-POS stream prints a cut receipt while the agent
   reports failure — the worst possible outcome for a kitchen/POS system.
2. **Win32 success is the BOOL return value.** `GetLastError` is only meaningful after a
   zero return; trusting it (the previous behaviour) turned healthy prints into
   ambiguous "unknown outcome" failures.
3. **Bound every blocking Win32 call from the caller.** `EnumPrinters`, `GetPrinter`,
   `OpenPrinter` and `WritePrinter` have no timeout of their own, so each runs on a
   helper goroutine the caller can abandon — with single-flight per printer so repeated
   timeouts cannot accumulate one blocked goroutine and handle each.
4. **Prefer `PRINTER_INFO_4` for enumeration.** Level 2 opens every remote connection and
   waits for RPC timeouts, so one dead queue could stall discovery entirely.
5. **Honesty over optimism in status.** An unanswered RPC reports `unknown`, never a
   fabricated `offline`; an unreadable queue is still reported (it exists) with
   `unknown` status rather than a fake `online`.
6. **Documentation must be derived, not hand-written.** `docs/DATABASE.md` is generated
   from `schema.ts` + migrations and checked by a stdlib script, so it cannot rot.
7. **Delete dead code only with reference proof**, and archive when uncertain.

## RESUME HERE

Push the branch and update the PR description with the UI fixes (PR #111 is open).
If the user reports that the card border glitch persists, the next hypothesis to check
is the fleet pill + refresh button wrapping inside the 44px card header at narrow
widths — the two reports were described in prose, not seen, so point 1 is diagnosed
from the divider semantics rather than from the image.

## Final summary

### Completed fixes — 16 code changes + 12 tests

**Go Agent (highest priority, 8 changes)**
1. `EndDocPrinter` verdict now uses the BOOL return value, not `GetLastError`.
2. Incomplete documents are **discarded** with `AbortPrinter` instead of being released
   by `EndDocPrinter` (previously emitted truncated RAW/ESC-POS output).
3. One shared `getPrinterInfo2` implementing the documented two-call sizing pattern with
   bounded `ERROR_INSUFFICIENT_BUFFER` retries and fail-closed short buffers (−50 duplicated lines).
4. `Status()` reuses the single-flight bounded probe: no more leaked goroutine +
   `OpenPrinter` handle per heartbeat timeout; unanswered RPCs report `unknown`.
5. `EnumSpoolerPrinters` rewritten to level 4 + 30 s bound + retry + registry cross-check
   + bounded per-queue details.
6. Win32 test hooks are mutex-guarded (fixes a real data race under `-race`).
7. Partial-write bytes are folded into the tracked total so discard logs match the
   returned evidence (capped so an over-reporting driver cannot fake completion).
8. 12 fake-syscall tests covering finalize/abort, EndDoc verdicts, cancellation
   contracts and queue-status classification.

**Gateway (3 changes)** — verify-email effect owns its request, redirect timer and
cancellation; `docs/DATABASE.md` + drift checker; dead component removal.

**Odoo (1 change)** — 12 user-facing messages marked for translation.

**Cleanup (1 change)** — 3 dead components deleted, 4 stale audit snapshots archived.

**Tauri/Rust** — reviewed, no defect found (permission map verified 22/22).

### Verified (commands actually executed here)

- `python3 scripts/check-db-docs.py` → `current tables: 24 … OK: schema.ts, migrations and docs/DATABASE.md are in sync.` `exit=0`
- Odoo `py_compile`: `47 files, 0 failures`
- Odoo `xml.dom.minidom`: `9 files, 0 failures`
- Toolchain probe: `go/cargo/rustc/psql/pytest: MISSING`; node v22.22.3 vs `.nvmrc` 24.21.0; no `node_modules`
- Earlier (before the local-only rule): windows-latest `go build -mod=readonly ./...` and
  `go vet -mod=readonly ./...` **succeeded** for all Agent changes, and the `go test -race`
  log confirmed the abort, bounded-status and level-4 discovery behaviour on real Windows.

### UNVERIFIED

- **UNVERIFIED: tool go is not available on this machine** → `go build`, `go vet`, `go test`,
  `GOOS=windows` cross-compile not run locally.
- **UNVERIFIED: tool cargo is not available on this machine** → `cargo check`/`cargo test` not run.
- **UNVERIFIED: tool rustc is not available on this machine.**
- **UNVERIFIED: PostgreSQL (psql) is not available** → constraint/trigger behaviour unverified.
- **UNVERIFIED: pytest is not available** → the Odoo addon's own test suite not executed.
- **UNVERIFIED: Node 24.21.0 (`.nvmrc`) and `node_modules` are absent and installing is
  forbidden** → Gateway typecheck, lint, build and vitest not run.
- **UNVERIFIED: requires physical printer testing** → real paper output, driver rendering,
  thermal/ESC-POS and label behaviour, XPS/EMF data types.
- **UNVERIFIED: real Windows service behaviour** → session-0 visibility of per-user queues,
  SCM stop/restart, service recovery.
- **UNVERIFIED: live Odoo 19** → POS asset bundle name (`point_of_sale._assets_pos`) and
  the `PosController.print_sale_details` override signature.
- **UNVERIFIED: the confirming windows-latest run** — the branch was fixed and pushed, but
  per the local-only rule the run result was not consumed.

### Remaining risks

1. The Agent changes were compiled and race-tested successfully on windows-latest once, but
   the final cancellation-test fix (and the byte-accounting fix) have **not** been observed
   on a Windows runner — they rest on code review plus the earlier green run.
2. Gateway/Odoo/Tauri changes are unverified by execution here; a typo-level error in the
   verify-email edit or the Odoo `_()` wrapping would surface only in CI or at runtime.
3. Print outcome remains honest-but-unknown in the cases where Windows cannot tell us
   (wedged RPC, `EndDocPrinter` failure on a complete document) — retry policy, not code,
   must resolve those.
4. `docs/DATABASE.md` is generated once; future schema changes must re-run
   `npm run db:docs:check` (it fails loudly on drift, which is the mitigation).

---

# Sub-task B — language, localization and RTL (ACTIVE)

## Task list

| # | Task | Status |
|---|------|--------|
| B1 | i18n core (catalogs, translate, formatters, provider, hook) | DONE — `4a97322` |
| B2 | App shell, navigation, RTL direction + logical CSS | DONE — `4a97322` |
| B3 | Dashboard | DONE — `5f0e9fd`/`5f0e9ad` |
| B4 | Auth + onboarding (login, signup, verify, forgot, reset, onboarding) | DONE — `d9ebd62` |
| B5 | Team, settings, billing, API keys, system health, BillingActions | DONE — `0bdd32c` |
| B6 | Remaining console surfaces (agents, printers, jobs, pricing, platform/*) | IN PROGRESS |
| B7 | Shared components (`ui.tsx`, `JobTimeline`, `UpgradeLimitDialog`, wizard, dialogs) | NOT STARTED |
| B8 | Desktop shell (`src/desktop/pages/*.tsx`) | NOT STARTED |
| B9 | Locale-aware date/number sweep (`toLocale*String` everywhere) | NOT STARTED |
| B10 | Raw server-error text → operator-safe messages | NOT STARTED |
| B11 | Terminology map applied consistently | NOT STARTED |
| B12 | Final hardcoded-string sweep + local gate + commit | NOT STARTED |

## Last file worked on

`src/app/system-health/system-health-client.tsx` — `STATE_LABEL` converted to `stateLabel(state, t)`.

## Decisions

- **Server components** (e.g. `src/app/billing/page.tsx`) use `src/i18n/server.ts`
  (`getServerLocale()` + `makeT(locale)`); client components use `useI18n()`.
  `server.ts` is intentionally excluded from the `src/i18n/index.ts` barrel so the
  Vite desktop build never pulls in `next/headers`.
- **Module-level helpers** that render copy must take the translator as a parameter
  (`planStatus(sub, t, formatDate)`, `rotationMeta(key, t)`, `stateLabel(state, t)`,
  `roleOptions(t)`, `expiryLabel(iso, t)`, `post(path, body, t)`). A global
  find/replace leaves `t` out of scope at module level — this bit twice already.
- **Plural keys** are `base.one` / `.two` / `.few` / `.many` / `.other` / `.zero`;
  `translateCount()` falls back through category → `other` → base.
- **Arabic digits** stay Latin (`ar-u-nu-latn`) so ids, IPs and ports remain scannable;
  English technical terms (Gateway, Agent, Printer, Print Job, Workspace, POS, API,
  WebSocket, USB, IP, Windows, Spooler, ESC/POS) are kept untranslated inside Arabic.
- **Raw API errors** are logged (`console.warn`) and replaced with an operator-facing
  sentence; only applied to `BillingActions` and system health so far.

## RESUME HERE

Continue with **B6**: the console surfaces listed by the inventory scan
(`src/app/agents`, `src/app/printers`, `src/app/jobs`, `src/app/pricing`,
`src/app/platform/*`, `src/app/page.tsx`).
