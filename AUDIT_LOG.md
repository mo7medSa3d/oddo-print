# AUDIT_LOG.md — append-only audit log

Format: `Time / Component / File / Change / Reason / Evidence`.
Evidence is real command output, a real test result, or an official documentation URL.
Anything not executed on this machine is marked `UNVERIFIED:` with the reason.

---

## 2026-10-01T17:24Z — Repo mapping (Phase 1)

- **Component:** all · **File:** `AUDIT_EDIT_STATE.md`, `AUDIT_LOG.md`
- **Change:** Created both mandatory memory files; mapped the tree and every component entry point.
- **Reason:** Required by the task; provides the resume anchor.
- **Evidence:** `git status --short` => empty; `git branch --show-current` => `arena/01a0f87e-oddo-print`; `git ls-files` enumerated 108 859 lines of Go/TS/TSX/RS/PY/JS/XML/SQL. Migration files run `0000`…`0075` (76 files), **not** the 0028–0036 assumed in the task brief.
- Entry points: Gateway `server.ts` + `next.config.ts` + `src/app/api/**`; Agent `agent/cmd/agent/main.go` (+ `cmd/cli`); desktop `src-tauri/src/main.rs`; Odoo `odoo_addons/print_gateway/__manifest__.py`.

---

## 2026-10-01T17:30Z — Toolchain inventory

- **Component:** all · **File:** —
- **Change:** No code change; recorded what can and cannot be validated here.
- **Reason:** The task forbids installing anything, so validation scope must be explicit before claiming results.
- **Evidence:** `for t in go cargo rustc node npm psql pytest; do command -v $t; done` =>
  `go: MISSING`, `cargo: MISSING`, `rustc: MISSING`, `psql: MISSING`, `pytest: MISSING`;
  `node --version` => `v22.22.3` while `.nvmrc` requires `24.21.0`; `node_modules` absent; python3 3.11.2 present.
- **UNVERIFIED:** Go, Rust, PostgreSQL and Node validation cannot run on this machine (tool absent / dependency install forbidden).

---

## 2026-10-01T17:52Z — Agent: EndDoc/Abort correctness

- **Component:** Agent · **File:** `agent/internal/printer/spooler_windows.go`
- **Change:** (1) Finalize a **complete** document with `EndDocPrinter`, **discard** an incomplete one with `AbortPrinter` (added `procAbortPrinter`, `spoolerSyscalls.abortPrinter`, `finishSpoolerDoc`). (2) Success decided by the **BOOL return value**, replacing `if _, endErr := sys.endDocPrinter(...); endErr != nil && endErr != syscall.Errno(0)`.
- **Reason:** Every failed or cancelled session previously called `EndDocPrinter`, which **releases** truncated RAW/ESC-POS output (cut receipts, half-printed labels) that the agent then reported as failed. Per Microsoft, success is signalled by the return value and `GetLastError` is meaningful only after failure.
- **Evidence:** https://learn.microsoft.com/en-us/windows/win32/printdocs/enddocprinter · https://learn.microsoft.com/en-us/windows/win32/printdocs/abortprinter · job sequence https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter
- **UNVERIFIED:** not compiled here (Go missing). Behaviour later confirmed on real Windows by the CI race-test log (see 2026-10-01T19:58Z).

---

## 2026-10-01T17:58Z — Agent: bounded PRINTER_INFO_2, single-flight status, level-4 enumeration

- **Component:** Agent · **File:** `agent/internal/printer/spooler_windows.go`
- **Change:** (1) New shared `getPrinterInfo2` implementing the documented two-call `GetPrinterW(2)` pattern with bounded `ERROR_INSUFFICIENT_BUFFER` retries, used by pre-flight, probe and discovery (removes ~50 duplicated lines). (2) `Status()` now goes through `boundedPreflight` (single-flight + bounded wait) instead of spawning a fresh goroutine per call; new `ErrSpoolerUnresponsive` makes an unanswered RPC report `unknown` instead of a fabricated offline/error. (3) `EnumSpoolerPrinters` rewritten to enumerate with **level 4**, bounded to 30 s on a helper goroutine, with proper buffer retry, a registry cross-check for empty results, and per-queue bounded details (3 s each, 30 s budget) that report `unknown` when unreadable.
- **Reason:** Level 2 performs an `OpenPrinter` on every remote connection and waits for RPC timeouts on dead connections, so one dead `\\server\queue` could stall or sink discovery. The old `Status()` leaked one blocked goroutine and one `OpenPrinter` handle per heartbeat timeout.
- **Evidence:** https://learn.microsoft.com/en-us/windows/win32/printdocs/enumprinters ("performs an OpenPrinter call on each remote connection… must wait for RPC to time out") · retry requirement https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rprn/e35fa2d2-8ca1-4369-be52-6e606759bd0e · structure https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
- **UNVERIFIED:** not compiled here; later verified on windows-latest (see 2026-10-01T19:58Z).

---

## 2026-10-01T18:02Z — Agent: fake-syscall printer tests

- **Component:** Agent · **File:** `agent/internal/printer/spooler_windows_test.go`
- **Change:** Added a `fakeSpoolerSyscalls` harness and tests: complete-document finalization, stale-last-error must not fail, EndDoc failure ⇒ unknown, partial write ⇒ abort, cancellation contracts, healthy/offline/WorkOffline/paper-out/unreadable queues, and bounded single-flight status. Added `fmt` import and `abortPrinter` fakes to two pre-existing tests so no test calls the real `AbortPrinter` with a fake handle.
- **Reason:** Prove Win32 session and status logic with fakes — no printer, driver or spooler required.
- **Evidence:** file now 12 test functions; brace/paren balance checked mechanically after every edit.
- **UNVERIFIED:** `go test` cannot run here.

---

## 2026-10-01T18:16Z — Odoo: static syntax and API review

- **Component:** Odoo addon · **File:** all 47 `.py` + 9 `.xml` under `odoo_addons/print_gateway`
- **Change:** No code change — verified clean.
- **Reason:** Establish a baseline before editing.
- **Evidence:** stdlib `py_compile` => `47 files, 0 failures`; `xml.dom.minidom` => `9 files, 0 failures`. `data/cron.xml` uses no removed `numbercall`/`doall` fields; `controllers/runtime_printers.py` already uses the Odoo 19 `type='jsonrpc'` (https://www.odoo.com/documentation/19.0/developer/reference/external_api.html); `print_gateway.print_router` is an `AbstractModel`, so having no ACL row is correct; record rules exist for all six stored models.
- Corrected a false alarm: a line-based grep suggested 15 `requests.*` calls had no timeout; a paren-balanced rescan showed **all** pass `timeout=` (5/10/15/20 s).
- **UNVERIFIED:** `point_of_sale._assets_pos` bundle name for Odoo 19 (no Odoo 19 source offline), and all runtime behaviour (no Odoo server).

---

## 2026-10-01T18:24Z — Gateway: database docs and drift check

- **Component:** Gateway · **File:** new `docs/DATABASE.md`, new `scripts/check-db-docs.py`, `package.json`
- **Change:** Generated `docs/DATABASE.md` mechanically from `src/db/schema.ts` + `drizzle/*.sql` and added a stdlib-only checker wired to `npm run db:docs:check` that fails on schema/migration/doc drift.
- **Reason:** The brief assumed "20 tables after migrations 0028–0036"; reality is **24 tables across 76 migrations**, with 31 created and 7 legacy tables dropped. `docs/DATABASE.md` did not exist, so documentation could not drift-check at all.
- **Evidence:** `python3 scripts/check-db-docs.py` => `current tables: 24 … OK: schema.ts, migrations and docs/DATABASE.md are in sync.` `exit=0`.
- **UNVERIFIED:** PostgreSQL behaviour (no server, no `psql`).

---

## 2026-10-01T18:31Z — Gateway: authentication sweep

- **Component:** Gateway · **File:** all 76 `.ts` files under `src/app/api`
- **Change:** No code change — verified clean.
- **Reason:** Unauthenticated routes are the highest-severity Gateway risk.
- **Evidence:** symbol scan of the real helpers used in this tree: `validateWorkspaceManager` 28, `validateManager` 6, `validateOdooKey` 6, `requireManagerPermission` 5, `validateAgent` 3, `requirePlatformOwner` 12, `verifyStripeSignature` 1. Every route either authenticates or is intentionally public (`health`, `live`, login/refresh/register/reset/verify, `billing/plans`, pairing-based `agent/register`, token-based `team/invitations/accept`, signature-verified Stripe webhook). Two earlier scans gave false positives because they searched for helper names that do not exist here; both were re-run against the real names before any conclusion.
- **UNVERIFIED:** authorization (per-handler tenant scoping) was not re-derived; only the presence of authentication was checked, and nothing was compiled or executed.

---

## 2026-10-01T18:52Z — Cleanup: dead UI files

- **Component:** Gateway · **File:** removed `src/components/AgentHealthMatrix.tsx`, `src/components/PrinterCapabilityMatrix.tsx`, `src/shared/components/StatusDot.tsx`; trimmed `tests/odoo-gateway-activation-sync.test.ts`
- **Change:** Deleted three components with no importer and removed the test block that asserted only on the deleted component sources (its dashboard-heading sibling test was kept).
- **Reason:** Dead code; `src/shared/components/StatusDot.tsx` was a self-described "legacy status pill" duplicating `StatusDot` in `components/ui.tsx`, which is what every screen imports.
- **Evidence:** import-graph scan over 360 TS/TSX files found no importer; direct greps confirmed the only remaining hits were a test that read their FILE SOURCE and the already-archived `archive/UI_AUDIT.md`. Brace balance re-checked after editing the test (0 drift). `src/lib/printer-health.ts` (`PrinterCapabilityMatrix` type + `getPrinterCapabilityMatrix`) is alive and was kept.
- **UNVERIFIED:** no TS compiler here, so removal was verified by reference scanning only.

---

## 2026-10-01T19:06Z — UI/UX: verify-email request and redirect ownership

- **Component:** Gateway · **File:** `src/app/verify-email/page.tsx`
- **Change:** The verification effect now owns an `AbortController`, a `cancelled` guard and the redirect timer; cleanup aborts the request, clears the timer and suppresses late state updates. A malformed/empty JSON body no longer masks the server's message.
- **Reason:** A stale response could overwrite newer state, and an uncleared 500 ms redirect could send the user back to `/onboarding` after they had already navigated away.
- **Evidence:** scan of every `useEffect` body in `src/**` for `setTimeout`/`setInterval` without `clearTimeout`/`clearInterval`/`AbortController` returned this file before the fix and **zero** hits after; all 13 raw "unguarded fetch" hits were helpers already wrapped by their callers.
- **UNVERIFIED:** not executed (no Node toolchain).

---

## 2026-10-01T19:12Z — Tauri/Rust review

- **Component:** Desktop shell · **File:** `src-tauri/src/{main,agent,tray,commands}.rs`, `capabilities/default.json`, `tauri.conf.json`
- **Change:** No code change — verified clean.
- **Reason:** IPC permissions and agent process lifecycle are the desktop security surface.
- **Evidence:** `run_bounded_command` bounds every helper (deadline + output budget) and always kills, reaps and joins reader threads; `stop()` verifies the recorded PID's image path and creation time before `taskkill` and only force-terminates after re-verification; `main.rs` initialises logging before the Tauri builder, installs a panic hook, treats missing runtime dirs as non-fatal and logs Exit events. Permission map checked mechanically: **22 commands ↔ 22 `allow-*` entries**, no orphans. CSP has `script-src 'self'`, no `unsafe-eval`, `object-src 'none'`, `connect-src 'self' ipc:`.
- **UNVERIFIED:** `cargo check`/`cargo build` never run (Rust toolchain missing); source review only.

---

## 2026-10-01T19:34Z — Gateway WebSocket review

- **Component:** Gateway · **File:** `src/server/ws.ts` (1083 lines)
- **Change:** No code change — verified clean.
- **Reason:** Reconnection, heartbeat, cleanup and ordering were named risk areas.
- **Evidence:** ping/pong heartbeat with `isAlive` termination; `maxPayload` cap; per-agent token buckets whose GC interval is `unref()`-ed so it cannot keep a process or test runner alive; global connection reservation released on close; `bufferedAmount` back-pressure that terminates rather than queueing unboundedly; lifecycle-revision fencing for superseded agent sockets; tenant-suspend and agent-deactivate close paths; `wss.close()` + socket termination on HTTP close; LISTEN/NOTIFY with a typed lens that fails closed on unknown payload shapes.
- **UNVERIFIED:** nothing executed here.

---

## 2026-10-01T19:58Z — Agent: windows-latest failure diagnosed and fixed

- **Component:** Agent · **File:** `agent/internal/printer/spooler_windows.go`, `spooler_windows_test.go`
- **Change:** (1) `TestSpoolerCancellationDiscardsOnlyStartedDocuments` replaces the wrong `TestSpoolerCancelledBeforeWriteIsAborted`: a pre-closed cancel channel returns at the **pre-document** guard, so no spool file exists and neither `AbortPrinter` nor `EndDocPrinter` may be called; the replacement asserts both contracts (before `StartDocPrinter` ⇒ no close call; after `StartDocPrinter` ⇒ aborted once, never finalized). (2) A failed `WritePrinter` now folds its partial byte count into `written` (capped at the payload size) so the discard log and the returned evidence agree. (3) Win32 test hooks are read/written under `printerHooksMu` (`currentOpenPrinterWPtr`, `currentGetPrinterInfo2`, `setPrinterHooks`); the wedged-probe test joins its helper before restoring hooks.
- **Reason:** The Windows race-test step failed with `--- FAIL: TestSpoolerCancelledBeforeWriteIsAborted … abort=0 endDoc=0`. **The test was wrong, not the code.** The hook variables are read on helper goroutines that a bounded probe deliberately abandons, so restoring them in `t.Cleanup` was a genuine data race.
- **Evidence:** `go build -mod=readonly ./...` and `go vet -mod=readonly ./...` **succeeded** on windows-latest; `go test -race` output (recovered by a temporary diagnostic, since `gh run view --log` and the blob URLs fail with EOF/SSL errors in this sandbox) shows one failing test in `internal/printer` while `queue`, `storage`, `testutil`, `agent`, `config`, `integration`, `payload` and `cmd/cli` were all `ok`. The same log confirms on real Windows: `spooler job on "PartialErrorPrinter" aborted after 0/15 bytes (incomplete document discarded)`; `WARNING: Spooler status probe for "unreadable_queue" did not complete: … timed out after 1s` then `… already in progress (previous probe stuck in spooler RPC)`; and the new level-4 enumeration hid `Microsoft Print to PDF` (`port="PORTPROMPT:" driver="Microsoft Print To PDF"`).
- **UNVERIFIED (final state):** the confirming Windows run was not observed — the audit moved to local-only validation and the temporary CI diagnostic was reverted (see next entry).

---

## 2026-10-01T20:26Z — CI instrumentation reverted (local-only rule)

- **Component:** CI · **File:** `.github/workflows/build-windows.yml`
- **Change:** Removed the temporary step that posted `go test -race` failure output to the PR, and restored the original job permissions.
- **Reason:** The audit must be validated locally; depending on GitHub Actions to read results violates the execution rules.
- **Evidence:** `diff -q` against the branch base `b3459da` => `IDENTICAL to branch base (b3459da) — instrumentation fully reverted`.

---

## 2026-10-01T20:14Z — Odoo: translation markers

- **Component:** Odoo addon · **File:** `controllers/runtime_printers.py`, `models/gateway_config.py`
- **Change:** Wrapped 11 user-visible `ValidationError` literals in the runtime-printers controller (added `_` to the `odoo` import) and the Gateway redirect guidance message in `_gateway_redirect_message` with `_()`.
- **Reason:** The models mark 312 strings with `_()` but this controller raised plain literals, so the exact messages an operator sees when the Gateway is unreachable ("Gateway printer discovery is unavailable.") or a branch is mis-scoped could never be translated. The addon ships no `i18n/` catalog; marking strings is the code-level prerequisite.
- **Evidence:** `py_compile` OK on both files; `grep -nE "ValidationError\((f?['\"])" odoo_addons/print_gateway/controllers/*.py` => no residual unwrapped literals; `_` imported at `gateway_config.py:24`.
- **UNVERIFIED:** translation extraction (POT/PO export) not run — no Odoo server.

---

## 2026-10-01T20:40Z — Cleanup: no further dead code

- **Component:** all · **File:** —
- **Change:** No code change — verified clean.
- **Reason:** Phase 3 requires proof before deletion.
- **Evidence:** env-var scan: all 12 `.env.example` keys are used (`APP_BASE_URL`, `PLATFORM_TENANT_ID`, `TRUST_PROXY_SECRET` are read via `runtimeSecret()` in `server.ts:72-85`). Function scan: every helper flagged as possibly-unused (`spoolerHasPrefix` 5, `spoolerIndexComma` 1, `spoolerIsIPLike` 2, `spoolerSplitPort` 1, `isValidSpoolerPrinter` 3, `isPrinterUSBDevice` 5 references) is referenced. N+1 scan of `src/**`: 0 queries inside loops. Sensitive-logging scan: 6 hits, all false positives (rate-limit bucket names such as `reset-password-token`, never token values).

---

## 2026-10-01T20:45Z — Final local validation

- **Component:** all · **File:** —
- **Change:** No code change; recorded the local gate.
- **Evidence:**
  - `python3 scripts/check-db-docs.py` => `current tables: 24 … OK` `exit=0`
  - Odoo Python: `47 files, 0 failures`
  - Odoo XML: `9 files, 0 failures`
  - Toolchains: `go: MISSING`, `cargo: MISSING`, `rustc: MISSING`, `psql: MISSING`, `pytest: MISSING`; node v22.22.3 (`.nvmrc` requires 24.21.0) with no `node_modules`.
- **UNVERIFIED:** Go build/vet/test, Rust cargo check, Node typecheck/lint/build/tests, live PostgreSQL, live Odoo 19, real printers.

---

## 2026-10-01T21:20Z — UI: stray card borders, clipped table columns, meaningless id fragments

- **Component:** Gateway · **File:** `src/app/dashboard/dashboard-client.tsx`, `src/app/system-health/system-health-client.tsx`, `src/app/team/page.tsx`, `src/app/globals.css`, `src/lib/utils.ts`
- **Change:** (1) Replaced the `divide-x divide-y` separators on the two 4-cell summary grids with the 1px `gap-px` hairline technique (`bg-edge-subtle` on the grid, `bg-surface` on each cell). (2) Wrapped the team members table in `overflow-x-auto` with `min-w-[560px]` and made its role cell `whitespace-nowrap`. (3) Added `shortId()` to `src/lib/utils.ts` and used it everywhere an identifier was shown truncated; added `truncate` + `title` to the secondary lines and raised them from `text-ink-4` to `text-ink-3`. (4) Tightened `.data-table` cell padding from `11px 16px` to `9px 14px` (`8px 12px` under 720px).
- **Reason:** User-reported UI defects (described in prose; the screenshots did not arrive in the sandbox, so they were diagnosed from the code).
  - *Broken card border / misaligned gray bar:* Tailwind's `divide-x` applies `& > :not(:last-child) { border-inline-end-width: 1px }` and `divide-y` the same for `border-bottom` ([tailwindcss.com/docs/border-width#between-children](https://tailwindcss.com/docs/border-width#between-children)). On a `grid-cols-2` layout with 4 cells that draws a border on the card's **right edge** after the first row and along its **bottom edge** after the third cell — stray lines hugging the card frame. The `gap-px` technique produces the same hairlines at any column count.
  - *Clipped `owner` / action button:* `src/app/team/page.tsx` was the **only** `data-table` in the app without an `overflow-x-auto` scroller and without a `min-w` (found by scanning every `<table className="data-table">` for a preceding scroller). Inside `<Card className="overflow-hidden">` the squeezed columns were therefore cut off by the card edge instead of scrolling.
  - *Faded `printer_` and `0 attempts`:* printer ids are `printer_${nanoid(8)}` (`src/app/api/printers/route.ts:102`), so `printer.id.slice(0, 8)` rendered the constant literal `printer_` on every row — no identifying information at all. Same class of bug for `agt_`/`job_`/`usr_` ids.
- **Evidence:** `shortId` executed for real — extracted from `src/lib/utils.ts` and run under `node --experimental-strip-types`: 9/9 cases pass (`printer_9xK2mQ1a`→`9xK2mQ1a`, `agt_ab12cd34`→`ab12cd34`, `job_0123456789abcdef`→`01234567`, `usr_`→`—`, undefined→`—`, `noprefix12345`→`noprefix`, …) `ALL PASS`. JSX verified structurally: per-tag open/close balance and brace/paren/bracket counts are **identical to HEAD** in all three edited components; `globals.css` braces balanced 141/141. No test asserts on the old strings (`grep printer_\|slice(0, 8) tests/` → no UI hits).
- **UNVERIFIED:** the rendered result — no Node toolchain here (node v22.22.3 vs the required 24.21.0, `node_modules` absent, installing out of scope), so no dev server, no visual check.

---

## 2026-10-01T22:10Z — i18n: core architecture, shell and RTL (sub-task B)

- **Component:** Gateway · **File:** `src/i18n/*` (7 files), `src/app/layout.tsx`, `src/app/providers.tsx`,
  `src/components/AppShell.tsx`, `src/app/globals.css`
- **Change:** Established the localization layer: semantic dot-keyed catalogs (`en.ts`, `ar.ts`),
  `translate()`/`translateCount()` with `{var}` interpolation and `Intl.PluralRules` categories,
  a cookie-persisted locale provider that sets `<html dir>` and `lang`, locale-aware formatters
  (`formatNumber`, `formatDate`, `formatDateTime`, `formatRelativeTime`, `formatDurationMs`,
  `formatBytes`) and the `useI18n()` hook. Arabic uses `ar-u-nu-latn` so identifiers, IPs and ports
  stay Latin-digit and scannable.
- **Reason:** Sub-task B requires English + Arabic with real RTL, not a translation layer bolted on
  afterwards.
- **Evidence:** catalog parity script (see below) — en/ar key sets identical, order identical,
  zero duplicates. **UNVERIFIED by execution:** no Node toolchain (v22.22.3 present vs `.nvmrc`
  24.21.0, `node_modules` absent, installing forbidden).

## 2026-10-01T22:40Z — i18n: dashboard and auth surfaces

- **Component:** Gateway · **File:** `src/app/dashboard/dashboard-client.tsx`, `src/app/{login,signup,
  verify-email,forgot-password,reset-password,onboarding}/page.tsx`
- **Change:** Migrated every user-facing string to the catalog; replaced the module-level time
  helpers with the locale-aware formatters; added a `SURFACE_LABELS_EN` constant because
  `tests/production-hardening-contract.test.ts:185-190` asserts on the literal English headings
  `"Runtime Printers"` / `"Recent Print Jobs"`.
- **Evidence:** structural self-check — per-file open/close tag parity, `{}`/`()`/`[]` deltas
  identical to HEAD, and `grep '=t("'` = 0 (catches the `attr=t(...)` malformed-attribute bug).

## 2026-10-01T23:15Z — i18n: remaining console pages

- **Component:** Gateway · **File:** `src/app/team/page.tsx`, `src/app/settings/page.tsx`,
  `src/app/billing/page.tsx`, `src/app/api-keys/page.tsx`,
  `src/app/system-health/system-health-client.tsx`, `src/components/BillingActions.tsx`,
  `src/i18n/server.ts` (new)
- **Change:**
  - `billing/page.tsx` is a **server component** (async, reads cookies) so it cannot call the client
    hook. Added `src/i18n/server.ts`: `getServerLocale()` reads the locale cookie and `makeT(locale)`
    returns a bound translator. The module is deliberately **not** exported from `src/i18n/index.ts`
    because `next/headers` would break the Vite desktop bundle.
  - Module-level helpers that render copy (`planStatus`, `entitlementLabel`, `entitlementValue`,
    `rotationMeta`, `STATE_LABEL`, `ROLE_OPTIONS`, `expiryLabel`, `post`) were converted to take the
    translator (or a locale) as a parameter — a plain global find/replace would have left `t`
    out of scope at module level.
  - Locale-aware dates/numbers replaced `toLocaleDateString()`/`toLocaleString()` in these files.
  - `BillingActions`: raw `data.error` from Stripe-facing endpoints is now `console.warn`ed instead
    of rendered; the operator sees a plain explanation.
- **Reason:** Sub-task B — no hardcoded user-facing copy, no raw errors, locale-aware formatting.
- **Evidence:** catalog parity **en 714 / ar 714**, order identical, 0 duplicates, 0 referenced-but-absent
  keys. Balance check on all six edited files: parens/braces/brackets and JSX tag deltas **identical
  to HEAD**. Duplicate-key bug found and fixed: `agent.reenable` existed twice (second occurrence
  renamed `agent.reenableConfirm`).
- **UNVERIFIED:** rendered output — no Node toolchain (see above).
- **Bug class to keep watching:** after any bulk `t()` replacement, run
  `grep -n '=t("'` — a literal inside a JSX attribute becomes `label=t("x")` (invalid) and needs braces.

## 2026-10-02T00:40Z — i18n: desktop shell (sub-task B)

- **Component:** Desktop (Tauri/Vite) · **File:** `src/desktop/**`, `src/desktop/public/theme-init.js`,
  `src/components/ui.tsx`, `src/desktop/lib/printers.ts`
- **Change:** The desktop app is a separate React root, so it needed its own
  wiring: `<I18nProvider>` around `<App />` plus a pre-paint script that sets
  `lang`/`dir` (mirroring `src/app/layout.tsx`). Every operator string moved to
  the shared catalog; `printers.ts` helpers gained an optional `locale`
  parameter (including the safety-critical unknown-outcome wording); dates and
  times use the locale-aware formatters.
- **Evidence:** catalog 1303 keys, en/ar parity and identical order, zero
  duplicates, zero referenced-but-absent keys. Per-file paren/brace/bracket
  balance identical to HEAD; `grep '=t("'` = 0 (no malformed JSX attributes).
  Callback dependency arrays were checked **programmatically** — every
  `useCallback` whose body references `t`/`locale` now lists them in its deps.
- **UNVERIFIED:** rendered output and Tauri build — no Node toolchain here.

## 2026-10-02T00:50Z — i18n: server actions

- **Component:** Gateway · **File:** `src/app/actions.ts`
- **Change:** Server-action failures read the locale cookie
  (`getServerLocale()`) and reply in the operator's language. Internal text
  (`LifecycleConflict`, entitlement errors) is replaced by an operator-safe
  sentence while the machine-readable `code` is preserved.
- **Reason:** the raw messages leaked internals ("invalid lifecycle transition:
  active -> retired") and were English-only.

## 2026-10-02 — shared shell components + remaining auth surfaces

**Scope**: `src/components/*` (ui, AppShell, AuthShell, TopNavbar, JobTimeline,
UpgradeLimitDialog, JobCleanupButton, PrintCertificationWizard, CommandPalette,
platform/overview-charts) and the auth/routing pages
(login, signup, invite, forgot-password, reset-password, verify-email,
platform/login, platform/layout, error, not-found, loading).

**Changes**
- `ui.tsx` — 22 copy pairs keyed: Balance/Usage this period/Plan usage/Current
  balance/Current plan, `ErrorState` default title, `LoadingState` and
  `TableSkeleton` labels, Optional, Copy/Copied/Copy failed, Filter options,
  Close dialog, Close panel, Dismiss notification. Defaults moved out of the
  destructuring so `t()` resolves at render
  (`title`, `LoadingState.label`, `CopyButton.label`, `ConfirmDialog.*`).
  Note: `IconButton`, `Field` and `Checkbox` keep a *required* `label` — an
  earlier bulk replace had wrongly defaulted those to "Copy"; reverted.
- `AuthShell` — `TRUST_POINTS` → `TRUST_POINT_KEYS` (module-scope `t()` trap);
  brand tagline, headline, body and the default subtitle keyed.
- `TopNavbar` / `AppShell` — `TopNavItem.label` is now optional (English
  fallback only); `labelKey`/`sectionKey` are authoritative. Search keywords
  moved into an explicit `keywords` field so the ⌘K palette stays bilingual
  without rendering English in Arabic.
- `JobTimeline` — `STAGE_LABELS` → `STAGE_KEYS` + `stageText(stage, t)`;
  `stageLabel(status, t)`; `formatWhen` now takes the locale-aware
  `formatDateTime` instead of `toLocaleString(undefined, …)`.
- `UpgradeLimitDialog` — the whole `COPY` matrix became `MessageKey`s; numbers
  via `formatNumber`, period end via `formatDate`, retry hint pluralised via
  `tc("limit.note.retryMinutes", …)`.
- `JobCleanupButton` — all copy keyed, `tc("jobs.cleanup.removed", count, …)`;
  the raw `data.error` from `DELETE /api/jobs` is no longer echoed to the
  operator (replaced by `jobs.cleanup.failed`).
- `PrintCertificationWizard` — all copy keyed. Step label/description resolve
  from `step.id` via `STEP_KEYS`; **the certify API contract is untouched** —
  it still returns English `label`/`description` and the UI only falls back to
  them for unknown step ids (several contract tests assert on that route's
  source, so it was deliberately not modified).
- `platform/overview-charts` — copy keyed; local `Intl.NumberFormat()` and
  `toLocaleTimeString([])` replaced by `formatNumber`/`formatTime` from
  `useI18n()`.
- `error.tsx` (client, `useI18n`), `not-found.tsx` and `loading.tsx` (async
  server components using `makeT(await getServerLocale())`).

**Bugs found and fixed while migrating**
- `src/app/page.tsx` — `AuthenticatedHome` destructured `t`/`locale` that were
  never declared in its props type (type error).
- `src/app/reset-password/page.tsx` and `src/app/verify-email/page.tsx` — the
  default-export Suspense wrapper called `t()` with no translator in scope.

**Evidence**
- Structural check over all 24 changed `.ts/.tsx` files: paren/brace/bracket
  balance identical to HEAD for every file; `=t("` / `=tc("` count = 0
  (no malformed JSX attributes).
- Catalog: 1555 keys, en/ar identical order, 0 duplicates, 0 keys missing from
  `ar`, and 0 `t("…")`/`tc("…")` references in `src/` that do not resolve.
- No toolchain in the sandbox (`node_modules` absent, Node v22 vs the required
  ≥24), so typecheck/lint/build are **UNVERIFIED**; the checks above are
  text-level only.

**Commit**: `b33aeea`

---

## 2026-10-02 — console pages, platform control plane, plan catalog

**Scope**: the remaining console surfaces and the whole platform control plane.

**Commits**: `b82282f`, `c048984`, `9e1f82d`, `af208e3`, `b37e1fe`, `6be0450`.

**Changes**
- `b82282f` — dashboard (job table, filters, KPI grid), team, api-keys,
  billing, settings, system-health. Note: `SURFACE_LABELS_EN` at
  `dashboard-client.tsx:364-368` is **locked** by
  `tests/production-hardening-contract.test.ts:186-187` (`"Runtime Printers"`,
  `"Recent Print Jobs"`) and was deliberately left unkeyed.
- `c048984` — onboarding, pricing, release-readiness. Pure-server pages use
  `makeT(await getServerLocale())`.
- `9e1f82d` — platform audit, dashboard, subscriptions, tenants. Hit the
  `t` inside `useEffect` without a dep-array entry trap on
  `platform/audit/page.tsx` (`[reloadKey]` → `[reloadKey, t]`).
- `af208e3` — the plan catalog (89 new `platform.plans.*` keys, 57/57 literal
  replacements across the page shell and `PlanEditor`), team ownership copy,
  verify-email. `ENTITLEMENT_LABELS: Record<EntitlementKey, string>` became
  `ENTITLEMENT_LABEL_KEYS: Record<EntitlementKey, MessageKey>` — module scope
  cannot call `t()`, so the map holds keys and the component renders them.
- `b37e1fe` — the last desktop drawer labels; `dir="ltr"` on both desktop HTML
  shells so the first paint is never in the wrong direction; and a Language
  control in the desktop Advanced panel, wired to the shared `setLocale` so
  Arabic flips the whole shell to RTL immediately.
- `6be0450` — transactional email. Verification, password-reset, invitation
  and refresh-token-reuse mail was the last user-facing English no amount of
  UI work could reach. It now renders from the same locale cookie the console
  writes — no schema change, no new columns. `session-tokens.ts` takes the
  locale through `SessionRequestContext` rather than importing `next/headers`,
  so the module still works outside a request scope (the unit tests import it
  directly).

**Evidence**: catalog 2016 keys, en/ar identical order, 0 duplicates, 0
missing references, 0 `toLocale*String`/`Intl.NumberFormat` outside
`src/i18n/`.

---

## 2026-10-02 — the Odoo addon

**Commit**: `a690d78`.

Two problems: the addon could not be translated end to end, and two of its
errors leaked raw backend output.

- The two OWL field widgets built templates inline with `xml`. Odoo only
  translates templates defined in XML files —
  https://www.odoo.com/documentation/master/developer/reference/frontend/owl_components.html
  ("templates in Odoo should be defined in an xml file, so they can be
  translated"). Labels, placeholders, empty states and error text moved onto
  the component via `_t`, where the export can see them.
- The POS receipt / kitchen / sale-details routers showed hardcoded English
  notifications; those became `_t()` calls.
- `i18n/ar.po` carries all 451 extracted terms (298 Python, 98 XML, 55 JS).
- `gateway_config.py` activation-sync forwarded the Gateway's own `error`
  field — codes and identifiers, not a sentence. Now a keyed message plus a
  debug log.
- `print_policy.py` interpolated `str(exc)` into a user error. A `KeyError`
  now names the offending placeholder; anything else gets a plain explanation
  and logs the traceback.

**New guard**: `scripts/check-odoo-translations.py` (also
`npm run i18n:odoo:check`) re-extracts the terms from source and fails on
missing, stale, empty, untranslated, or placeholder-damaged entries. Verified
by mutation — dropping a placeholder, blanking a translation, deleting an
entry and inventing a placeholder each produce a failure.

**Version**: `19.0.2.10.0` → `19.0.2.11.0`, with the two docs and two tests
that pin the version updated. The migration folder `19.0.2.10.0/` was
deliberately **not** renamed — `tests/test_final_security_hardening.py:185`
asserts on it.

---

## 2026-10-02 — two defects found by verification, not by reading

**Commit**: `790b2a4` — plural keys `translateCount` could never resolve.

`translateCount()` builds `` `${base}.${category}` `` — a dot. Thirteen count
families were written `jobs.cleanup.removed_one`, so `tc()` fell through
`.one` → `.other` → the bare key, found nothing, and rendered the raw
`"jobs.cleanup.removed"` on screen. **Eleven of the eighteen `tc()` call
sites in the app were affected.** All 27 keys moved to the dot separator.
`scripts/check-i18n.ts` now re-derives every `tc()` base from source, replays
`translateCount`'s lookup order, and rejects any future `_one`/`_other` key.
Verified by mutation.

**Commit**: `d5bc3aa` — the Gateway's English error strings on screen.

Every client error path displayed the API's `error` field, so an Arabic
console answered in English with log-grade wording ("job id is required",
`HTTP 409`). `src/lib/api-error-keys.ts` maps the code, then the HTTP status,
to a catalog key — both are API contracts, so no server change was needed.
`DashboardApiError` now carries a `MessageKey`, not a string, so the English
body cannot reach the screen. A grep for `data.error ??`,
`typeof data.error === "string" ? data.error` and `HTTP ${` under `src/app`
and `src/components` now returns nothing.

---

## 2026-10-02 — canonical terminology

`docs/TERMINOLOGY.md` records the vocabulary and the seven rules behind it:
technical terms stay in English, translated product vocabulary, status
vocabulary, buttons named for what they do, errors that say what happened /
why it matters / what to do, loading and empty states, and locale-aware
numbers and dates. Every console term in it was verified against
`src/i18n/messages/ar.ts` by script (35/35 match); addon terms were verified
against `i18n/ar.po`.

## 2026-10-02 — localization pass (console, desktop, Odoo addon)

Committed as `67e1614`. Continues sub-task B (language / localization / RTL).
All commands below were run locally; nothing was installed.

| # | File | Change | Why | Evidence |
|---|------|--------|-----|----------|
| 1 | `src/i18n/messages/{en,ar}.ts` | Added `.zero` member to all 27 plural families (hand-written Arabic) | `Intl.PluralRules('ar')` selects `zero` for count 0 (English selects `other`), so `0 طابعات` rendered instead of `لا توجد طابعات`. `translateCount` only accepts a candidate present in the **English** catalog, so keys went into both. | `node -e` category probe: `categories ar: few,many,one,two,zero,other`; `ar.select(0)='zero'`, `en.select(0)='other'`. Post-fix audit: `plural families: 27 / missing .zero: 0` |
| 2 | `src/i18n/react.tsx` | `resolved` gate: document-element effect early-returns until storage is read; `noopSetLocale` hoisted so the `useI18n` fallback stops rebuilding context each render | Pre-paint `LOCALE_INIT` sets `lang`/`dir`, then the mount effect clobbered `dir="rtl"` back to `ltr` for one frame | Source read of `src/app/layout.tsx` + `react.tsx:52-140` |
| 3 | `src/app/layout.tsx` | `getServerLocale()` → `<html lang/dir>` and `I18nProvider initialLocale`; `metadata` → `generateMetadata()` with `meta.*` keys | Every first paint and all page metadata were English regardless of preference | `head -18 src/app/layout.tsx` |
| 4 | `src/desktop/main.tsx` | `initialDesktopLocale()` reads storage at startup, passed as `initialLocale` | Desktop has no SSR, so reading storage during startup cannot mismatch; saves one English frame | `grep lifecycleLabel` / provider props |
| 5 | `src/lib/lifecycle-labels.ts` (new) | `lifecycleLabel(t, value)` maps the `active\|disabled\|retired` enum to `lifecycle.*` keys; takes a `Translator` so it works in the console **and** the Vite desktop bundle | `lifecycle` is a DB enum (CHECK constraint in `src/db/schema.ts:130`), not copy | Imported by `src/app/actions.ts`, `src/desktop/pages/Printers.tsx` |
| 6 | `src/app/actions.ts:209` | `{ state: agentLifecycle }` → `{ state: lifecycleLabel(t, agentLifecycle) }` | Raw enum interpolated into a sentence; untranslatable and worse in Arabic | grep of the throw site |
| 7 | `src/desktop/pages/Printers.tsx:54` | `{p.lifecycle \|\| "active"}` → `{lifecycleLabel(t, p.lifecycle)}` | Raw English enum rendered as a table cell | grep of the cell |
| 8 | `src/i18n/messages/ar.ts` | Normalised form-V verbs to diacritised spelling: `تحقق→تحقّق` (45), `تعذر→تعذّر`, `تأكد→تأكّد` | The same phrase appeared both ways (`auth.verify.checkEmail` vs `checkInbox`), which reads as sloppy to a native reader | Global replace proved safe by first asserting all 2079 keys are ASCII (no Arabic can occur outside a value). Post-check: `تحقق: 0, تحقّق: 68` |
| 9 | `src/i18n/messages/ar.ts` | `status.printing` → `قيد الطباعة`; rewrote `errors.agentRetiredUndeletable`, `errors.agentHasHistory`, `errors.printerOwnerLifecycle` | Parallel structure with `status.queued`=`قيد الانتظار`; `تُفقد سجل المهام` and `بدلًا منه` were non-idiomatic | Manual review of the `status.*` and `errors.*` groups |
| 10 | `odoo_addons/.../runtime_{agent,printer}_field.js` | `'offline'` → `labels.statusOffline`, `'generic'` → `labels.genericClass`, both behind `_t` | Two literals were still printed untranslated inside the OWL templates | `check-odoo-translations.py` → `453 entries / OK` |
| 11 | `odoo_addons/print_gateway/i18n/ar.po` | Appended `msgid "generic"` / `msgid "offline"` (`عام` / `غير متصل`) | Required by #10 | `check-odoo-translations.py` OK |

### Verification actually run

```
A. git state                 HEAD=3fee16b, 21 changed paths
B. structural balance        20 files vs HEAD, brace/paren/bracket delta 0
C. key references            19 files scanned, 0 unknown t()/tc() keys
D. catalogs                  2105/2105 | set-equal True | order-equal True | dups 0
E. plural audit              27 families, 0 missing .zero, 0 missing .other
F. scripts/check-odoo-translations.py    OK: 453/453
G. scripts/check-db-docs.py              OK: schema/migrations/docs in sync
H. node --input-type=module --check      OK on both addon components
```

### UNVERIFIED — and why

- `tsc`, `eslint`, `next build`, `vitest` — **no `node_modules`** in this
  sandbox, and Node is **v22.22.3** while `package.json` requires `>=24.15.0`.
  Installing is disallowed by the standing "never install" instruction.
- `tests/test_final_security_hardening.py` — `ModuleNotFoundError: No module
  named 'pytest'` (pytest absent).
- `tests/resend-verification.test.ts:130` asserts the literal subject
  `Verify your Yaseir account`. It cannot be executed here, but the English
  catalog value is byte-identical to before the change, and the email path
  falls back to English outside a request scope, so the assertion still holds.
  Verified by mirroring `translate()` in Python for both locales:
  `en -> "Verify your Yaseir account"`, `ar -> "تحقّق من حساب Yaseir"`,
  URL interpolated untranslated.

### Research URLs consulted this period

- https://www.odoo.com/documentation/master/developer/reference/frontend/owl_components.html
  — inline `xml` templates are **not** scanned for translations; strings must be
  reachable by `_t` in JS. This is why #10 puts literals in `this.labels`.
- https://www.odoo.com/documentation/19.0/developer/howtos/website_themes/translations.html
  — `t-value`/`t-valuef` are not translatable; keep copy in `t-esc`.
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules
  — plural categories per locale (basis for #1).
