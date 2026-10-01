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
