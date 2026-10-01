# AUDIT_EDIT_STATE.md

Branch: `arena/01a0f87e-oddo-print` (branched from `b3459da`, never `main`).
Last updated: 2026-10-02 · Last modified file: `src/lib/api-error-keys.ts` (new), `docs/TERMINOLOGY.md` (new),
`odoo_addons/print_gateway/i18n/ar.po` (new), `scripts/check-odoo-translations.py` (new).

## Current phase

**Phase 5 (validation) complete for both sub-tasks → final step: push and Pull Request.**
All five phases have been executed for sub-task A (UI defects) and sub-task B
(localization). The remaining actions are pushing the branch and publishing the PR summary.

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

# Sub-task B — language, localization and RTL (COMPLETE)

## Task list

| # | Task | Status |
|---|------|--------|
| B1 | i18n core (catalogs, translate, formatters, provider, hook) | DONE — `4a97322` |
| B2 | App shell, navigation, RTL direction + logical CSS | DONE — `4a97322` |
| B3 | Dashboard | DONE — `5f0e9ad`, `b82282f` |
| B4 | Auth + onboarding | DONE — `d9ebd62`, `b33aeea`, `c048984`, `af208e3` |
| B5 | Team, settings, billing, API keys, system health | DONE — `0bdd32c`, `b82282f` |
| B6 | Remaining console surfaces (pricing, platform/*) | DONE — `c048984`, `9e1f82d`, `af208e3` |
| B7 | Shared components (`ui.tsx`, `JobTimeline`, `UpgradeLimitDialog`, wizard, dialogs) | DONE — `b33aeea`, `d5bc3aa` |
| B8 | Desktop shell (`src/desktop/**`) | DONE — `8ffe15b`, `a783bf5`, `665b5fb`, `b37e1fe` |
| B9 | Locale-aware date/number sweep | DONE — `grep` returns 0 hits outside `src/i18n/` |
| B10 | Raw server-error text → operator-safe messages | DONE — `d5bc3aa`, plus `a690d78` for the addon |
| B11 | Terminology map | DONE — `docs/TERMINOLOGY.md` |
| B12 | Transactional email | DONE — `6be0450` |
| B13 | Odoo addon translation | DONE — `a690d78` |
| B14 | Final hardcoded-string sweep + local gate | DONE — see below |

## Final report — sub-task B

### What was fixed

**Localization architecture** (`4a97322`)
- `src/i18n/` — typed catalogs (`en.ts` / `ar.ts`), `translate()` /
  `translateCount()`, a `useI18n()` hook, a server-side `makeT()`, and locale
  helpers (`formatNumber`, `formatDate`, `formatDateTime`, `formatTime`).
- Semantic dot keys (`navigation.dashboard`, `printer.status.offline`,
  `errors.gatewayUnavailable`) — no English sentence is ever a key.
- Arabic plural categories: `Intl.PluralRules` picks one of six forms.
- **RTL**: `dir`/`lang` set on `<html>` by a pre-paint script (no flash),
  logical CSS properties throughout, and Arabic digits pinned to Latin
  (`ar-u-nu-latn`) so IDs, IPs and ports stay scannable.

**Coverage** — 2,030 console/desktop keys in English and Arabic, plus 451 in
the Odoo addon. Every page, dialog, empty state, error state, loading state,
table header, `aria-label` and confirmation dialog in the Gateway console, the
desktop shell and the Odoo addon.

**Copy quality**
- Errors say what happened, why it matters and what to do next. Stack traces,
  raw JSON, SQL, internal IDs and exception names no longer reach the screen
  (`d5bc3aa` removed the last ten of them; `a690d78` removed two in the addon).
- Buttons are named for what they do. A grep for `"Submit"`, `"Execute"`,
  `"Proceed"` and `>OK<` returns 0 hits.
- Loading states end in a consistent ellipsis; empty states say what is empty,
  why, and what to do.
- Two places the product used different words for the same thing were
  reconciled against `docs/TERMINOLOGY.md`.

**Bugs found by verification, not by reading**
1. **`790b2a4`** — 13 plural families were written `x_one` but
   `translateCount()` builds `x.one`. **Eleven of the eighteen `tc()` call
   sites in the app rendered the raw key on screen** — e.g. a user cleaning up
   jobs saw the literal text `jobs.cleanup.removed`. Fixed; a permanent guard
   now replays `translateCount`'s lookup against the catalog.
2. **`a690d78`** — the Odoo addon's two OWL widgets built templates inline
   with `xml`, which Odoo does not translate at all, so their labels,
   placeholders and errors were unreachable by any translation.
3. **`d5bc3aa`** — every client error path displayed the API's English
   `error` field, so an Arabic console answered in English.

**New guards** — `scripts/check-i18n.ts` extended (count-family separator +
`tc()` resolution); `scripts/check-odoo-translations.py` added
(`npm run i18n:odoo:check`). Both were verified by mutation.

### What was verified, and with what evidence

| Check | Command | Result |
| --- | --- | --- |
| Console catalog parity, empties, placeholders, count families | Python mirror of `scripts/check-i18n.ts` | 2030/2030 keys, 27 families, **0 problems** |
| `tc()` call sites resolve | script replaying `translateCount`'s lookup | 16 bases, **0 unresolvable** |
| Underscore plural families | script | **0** |
| Odoo addon catalog | `python3 scripts/check-odoo-translations.py` | 451/451 terms, **OK**, `exit=0` |
| Catalog key references | script over `git ls-files src` | **0** unresolved `t("…")` |
| Structural balance vs `HEAD` | per-file paren/brace/bracket diff | 15 files, **0 issues** |
| Malformed `t("key"})` | regex scan | **0** |
| Locale-unaware formatting | `grep toLocale*String\|Intl.NumberFormat src/` | **0** outside `src/i18n/` |
| Raw error forwarding | `grep 'data.error ??'\|'HTTP ${'` | **0** |
| Banned button labels | `grep '"Submit"\|"Execute"\|"Proceed"\|>OK<'` | **0** |
| Addon Python syntax | `python3 -m py_compile` | **OK** |
| Addon JS syntax | `node --input-type=module --check` (Node v22) | 8/8 files **OK** |
| Terminalogy map accuracy | script comparing 35 console terms to `ar.ts` | **35/35 match** |
| Guard effectiveness | mutation tests (dropped placeholder, blanked translation, deleted entry, renamed family) | each produced a **failure** |

### UNVERIFIED — and why

- **UNVERIFIED: `node_modules` is absent and installing is forbidden.** Node is
  v22.22.3 but the project requires ≥24.15.0. Therefore `tsc --noEmit`,
  `eslint`, `next build`, `vitest` and `npm run i18n:check` were **not run**.
  `scripts/check-i18n.ts` itself is new/unmodified-TS and was validated by
  reproducing its rules in Python, not by executing it.
- **UNVERIFIED: pytest is not installed** → the Odoo addon's own test suite
  (`tests/test_odoo19_printing_static.py`,
  `tests/test_final_security_hardening.py`) did not run. Two assertions in them
  pin the addon version and were updated to `19.0.2.11.0` by hand.
- **UNVERIFIED: no Odoo instance** → `ar.po` was never loaded by Odoo. Its
  structure, escaping and placeholder handling are verified by a hand-written
  parser, not by `msgfmt` or by Odoo's importer.
- **UNVERIFIED: no browser** → RTL layout, font sizing, Arabic clipping, table
  and modal overflow were addressed by writing logical CSS properties and
  reading the source. Nothing was rendered.
- **UNVERIFIED: the Go Agent CLI is still English.** `agent/cmd/cli` prints
  help, diagnostic reports and error text in English. It is a Windows console
  tool for IT administrators; localizing it needs a Go i18n framework plus
  locale detection on Windows, and with no Go toolchain in the sandbox it
  could not be compiled or tested. Deliberately left alone rather than edited
  blind.
- **UNVERIFIED: the Odoo tour file** (`static/src/js/tours/binding_cascade_tour.js`)
  keeps its English step text. It is a developer QA script whose `content:`
  strings are assertions like `"Wait for .o_form_saved confirmation"`, not
  product copy.

### Remaining risks

1. **No typecheck ran.** The most likely residual defect is a type error in the
   14 files touched by `d5bc3aa` — particularly `DashboardApiError`, whose
   constructor signature changed from `(message: string, …)` to
   `(key: MessageKey, …)`, and the five files that gained an import.
2. **Unrendered RTL.** Logical properties are correct by inspection, but
   third-party components (the Odoo web client, `lucide-react` icon
   directionality) were not exercised in a browser.
3. **Arabic copy quality is self-reviewed.** All 2,481 strings were authored
   directly in MSA; none has been read by a native reviewer.
4. **Email locale is best-effort.** The locale cookie is the only signal
   available without a schema change, so a user who never opened the console
   gets English mail.
5. **`ar.po` has no `POT-Creation-Date` from a real export.** It was generated
   by script; re-exporting from Odoo will re-order and re-wrap entries. The
   checker, not the file layout, is the contract.
