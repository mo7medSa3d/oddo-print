# Audit edit state — Odoo Print Gateway

Branch: `arena/01a0f87e-oddo-print`
Last commit: `b57add0` (+ uncommitted sub-task C work below)
Updated: 2026-10-02

> Full chronological history lives in the append-only `AUDIT_LOG.md`.

**Sub-task C (Go Agent / Windows printing) is IN PROGRESS.** Go is not installed
here, so nothing in it has been compiled or test-executed — see the UNVERIFIED
block in that section before trusting any of it.

---

## Sub-task A — three Gateway UI bugs — **DONE**

Committed `d5ba36f`, pushed, PR #111 updated. Card border glitch, sidebar/table
clipping, poor row hierarchy and dim clipped ids. Acceptance met as far as is
verifiable without rendering (no browser in this sandbox).

---

## Sub-task B — language, localization, RTL — **DONE (awaiting push)**

### Task list

| # | Task | Status |
|---|------|--------|
| 1 | MessageKey migration audit | **DONE** — clean |
| 2 | Hardcoded user-facing strings | **DONE** — 12 fixed, plus system-health, desktop, OWL fallbacks |
| 3 | Arabic quality review | **DONE** — plural `zero` forms, diacritics, 3 rewrites |
| 4 | RTL + hydration | **DONE** — SSR locale, `resolved` gate, desktop startup |
| 5 | Email localization | **DONE** — verified both locales, EN byte-identical |
| 6 | Remaining-hardcoded-string re-scan | **DONE** — scanner re-run, triaged |
| 7 | Odoo / frontend consistency | **DONE** — catalog 453/453 |
| 8 | Test run | **PARTIAL** — see UNVERIFIED |

### What was fixed this period (`67e1614`)

1. **Arabic plural `zero` forms** — the substantive defect. `Intl.PluralRules('ar')`
   selects `zero` for count 0; 23 of 27 plural families had no `.zero` member, so
   a zero count rendered "0 طابعات" instead of "لا توجد طابعات". All 27 now have
   hand-written zero forms.
2. **RTL hydration** — `I18nProvider` clobbered the pre-paint script's `dir="rtl"`
   for one frame; gated behind a `resolved` flag.
3. **Server-rendered locale** — `layout.tsx` resolved nothing, so every first paint
   and all metadata were English. Now passes `getServerLocale()` to `<html>` and to
   the provider; `metadata` → `generateMetadata()`.
4. **Desktop startup locale** — reads storage directly (no SSR, so no hydration risk).
5. **DB enum leaking into copy** — `lifecycle` (active|disabled|retired) was
   interpolated raw into a sentence and rendered raw in the desktop printers table.
   New `src/lib/lifecycle-labels.ts` + `lifecycle.*` keys route both through `t`.
6. **Arabic copy quality** — form-V verbs normalised to diacritised spelling
   (`تحقق→تحقّق` etc., 82 values); `status.printing` made parallel with
   `status.queued`; three non-idiomatic sentences rewritten.
7. **Odoo** — `offline`/`generic` fallbacks moved behind `_t`; catalog 453/453.

### Verified — with evidence

```
catalogs            2105/2105 | set-equal True | order-equal True | dups 0
plural audit        27 families | missing .zero 0 | missing .other 0
key references      19 changed files scanned | 0 unknown t()/tc() keys
structural balance  20 files vs HEAD | brace/paren/bracket delta 0
scripts/check-odoo-translations.py   OK: 453 entries
scripts/check-db-docs.py             OK: schema/migrations/docs in sync
node --check (addon components)      OK x2
plural category probe (node -e)      ar=zero en=other for count 0
email path (Python mirror of translate)  en unchanged, ar translated, URL preserved
```

### UNVERIFIED — and why

- `tsc`, `eslint`, `next build`, `vitest` — **no `node_modules`**, and Node is
  **v22.22.3** while `package.json` requires `>=24.15.0`. Installing is barred by
  the standing "never install" instruction.
- `tests/test_final_security_hardening.py` — `ModuleNotFoundError: No module named
  'pytest'`.
- `tests/resend-verification.test.ts:130` asserts the literal subject
  `Verify your Yaseir account`. Not executable here, but the English value is
  byte-identical to before and the email path falls back to English outside a
  request scope, so the assertion still holds.
- No rendering verification is possible: no browser, no screenshots (the user
  confirmed `/home/user/uploads/` does not exist and images cannot be read). All
  UI conclusions came from source reading.

### Remaining risks

- **Type-level verification is absent.** The plural keys, the `Translator` type
  and `lifecycle-labels.ts` are all new; without `tsc` a type error would not be
  caught locally. This is the single largest risk in the change set.
- **No visual confirmation of RTL.** The hydration and logical-CSS work is
  reasoned from source, not observed. A manual pass in a browser at 1280px and
  390px, EN and AR, is still advisable.
- `tests/resend-verification.test.ts` and the React hook tests should be run in
  CI, where Node 24 and `node_modules` exist.

---

## Conventions locked in

- Semantic dot keys only — no English sentences as keys.
- Technical terms stay English inside Arabic: Gateway, Agent, Printer, Print Job,
  Workspace, POS, API, WebSocket, USB, IP, Windows, Spooler, ESC/POS.
- Numbers, ids, IPs, timestamps and URLs are never translated or reordered.
- Raw exception text, SQL and internal ids belong in `details`, never in the
  user-facing sentence.
- Server-emitted enums are mapped to message keys before display.
- Catalogs are kept set-equal and order-equal; a checker that reports 0 for a
  category that must be non-zero is broken, not passing.

## Sub-task C — Windows Agent printing pipeline (Go) — **IN PROGRESS**

### Fixed

1. **Unicode normalization in stable printer IDs** (`internal/printer/stable_id.go`) —
   NFC folding added at every identity input. Without it, an Arabic queue name
   arriving in NFD hashed to a different ID than the same name in NFC, so one
   physical printer was inventoried twice. Demonstrated before/after in
   `AUDIT_LOG.md`. Backward compatible: folding is a no-op for NFC names.
2. **`getDeviceInstanceID` two-call pattern** (`internal/printer/usb_windows.go`) —
   the sizing call's return value was discarded and GetLastError was thrown away.
   Now asserts ERROR_INSUFFICIENT_BUFFER per the documented contract and
   surfaces real errors.

### Round 2 (SNMP/WSD discovery + service lifecycle)

3. **SNMP identity split across port reachability** (`snmp_discovery.go`) — the
   ID was built from the live TCP observation, and `Port: 0` (port unreachable)
   falls through to a different ID namespace than `Port: 9100`. **One physical
   printer produced two IDs**, and duplicates accumulated every time the port
   flapped. Identity is now pinned to the intended print port.
4. **SNMP context timeout ignored the retry budget** — context was 600ms while
   `Timeout: 600ms` + `Retries: 1` needs 1200ms, so the retry was silently dead
   configuration.
5. **WSD discovery ignored context cancellation for up to 2.5s** —
   `SetReadDeadline` is one absolute time, invisible to an already-blocked
   `ReadFromUDP`. Added a watchdog that pulls the deadline forward.
6. **Data race on `program.agent`** (`cmd/agent/main.go`) — written by the
   Start-owned restart loop, read by `Stop` on the SCM goroutine, unsynchronised.
   `Stop` could skip closing the SQLite queue and leak it. Guarded with a mutex.

### Audited and found correct (no change)

Spooler session lifecycle and EndDoc/Abort discipline · EnumPrinters level 4
choice · UTF-16 handling throughout · GetLastError discipline (scanned all 113
files, 0 real hits) · job lifecycle and duplicate prevention · payload types
(the missing `text` type is correct — it matches the gateway's `DocumentType`) ·
config persistence · service lifecycle is otherwise sound (Start does not block,
Stop is bounded at 27s inside the SCM's ~30s, SQLite deliberately kept open
until `Run` returns).

### Tests added but NOT RUN

- `internal/printer/stable_id_unicode_test.go` — 7 tests (round 1).
- `internal/printer/discovery_identity_test.go` — 4 tests (round 2).

Go is absent, so none of the 11 tests have ever been executed.

### UNVERIFIED

- Nothing compiled: `go build` / `go vet` / `go test` / `gofmt` all impossible.
- Fix #2 needs Windows + real USB hardware; the SetupAPI proc is not injectable.
- All real-hardware behaviour: discovery accuracy, ESC/POS raster output,
  spooler behaviour under stall, service lifecycle, reconnect under real loss.
- Not re-audited in depth: `snmp_discovery.go`, `wsd_discovery.go`, `ipp*.go`,
  `pdf_windows.go`, `registry.go`, `cmd/agent/main.go` service wiring.

## RESUME HERE (Integration-defect delivery round — in progress 2026-10-02)

Main checkout is FROZEN (foreign UU/stash state, do not touch). Delivery
proceeds from worktree `audit-fixes-delivery` (base `dc8b7c4b` + patch +
4 new test files). Fixes 1 (Odoo submission), 2 (5 MiB), 3 (unknown-pin
test only, no defect), 5 (spoolerJobId, Go) implemented + verified (see
AUDIT_LOG.md delivery entry for evidence). Fix 4 (Agent 409) BLOCKED on
conflicted `agent/internal/agent/agent.go` — spec recorded, not applied.
Next: full gate in worktree → logical commits → push → watch CI.

## RESUME HERE (Audit Pass 2 — COMPLETE, all CI green 2026-10-02)

5 commits on `main` (`ddf9cc3`, `39e0c51`, `d0c1ffd`, `0ca3238`, `8091994`),
pushed, all five workflows success on `8091994` (CI incl. odoo19,
Windows installer, Docker, both security gates).

What was fixed vs the previous state: CI red→green (alias-grep self-hits
+ 3 Odoo runtime failures); Go lifecycle races/Fatal/PDF slot/WSD cap;
14 lint warnings → 0; 5 stale pytest assertions; 2 leftover English bodies
keyed. Full detail in AUDIT_LOG.md (Pass 2 entries).

Verified by EVIDENCE (local command or CI run — nothing claimed otherwise):
- Local: go build/vet (linux + GOOS=windows), gofmt, go test 9 pkgs ok,
  go test -race printer ok; tsc 0; eslint 0/0; vitest 722 passed/0 failed;
  next build ok; i18n/db-docs/odoo checks ok; py_compile 47/0; XML 9/0;
  pytest 136/136; yaml.safe_load all workflows; alias-grep gate clean.
- CI (push 8091994): all 5 workflows success — incl. windows-latest
  go build/vet/race + cargo check/build/test + MSI/NSIS smoke, Odoo 19
  runtime suite (199 tests), Postgres integration + migration on empty DB,
  Docker compose + WS smoke. (Local Node v22.23.1 vs required 24; CI ran 24.)

Remains UNVERIFIED and why:
  1. Real Windows service/printing hardware (spooler output, USB discovery,
     SNMP/WSD against physical devices, SCM stop) — no Windows host or
     printers here; covered only by CI's windows-latest job without hardware.
  2. Live Stripe (webhook e2e, past_due/unpaid transitions) — no live keys.
  3. Live Odoo 19 production behavior beyond the CI suite.
  4. PostgreSQL E2E beyond CI (no local server).
  5. Visual/RTL browser check (no browser here).

Next session: pick up any new CI failures or start from the UNVERIFIED list
with hardware access. Re-read this file + AUDIT_LOG.md after compaction.

---

## Audit Pass 2 (2026-10-02, branch `main` @ `df64881`)

Environment probe result:
`node v22.23.1 / npm 10.9.8 / go 1.26.8 / cargo 1.98.1 /
python 3.14.7 / pytest 8.3.3 / docker 29.7.2 / gh 2.97.0`,
`git status` clean, branch `main`. Node is below the required
`>=24.15.0` (CI runs 24.21.0 via .nvmrc); local Node results carry that
caveat. Nothing installed (all tools pre-existing).

| # | Task | Status |
|---|------|--------|
| P0-1 | CI triggers/permissions/pinning/secrets review | **DONE** — least-privilege, SHA-pinned, no leaks |
| P0-2 | Add missing CI jobs (i18n:check, i18n:odoo:check, db:docs:check) | **DONE** |
| P0-3 | Add missing job timeouts | **DONE** — all 9 jobs |
| P0-4 | CD review (Dockerfile/compose/Caddy/migrate ordering) | **DONE** — verified sound |
| P1-1 | Go build/vet/gofmt/test/race/GOOS=windows | **DONE** — all green, first local run ever |
| P1-2 | Deep audit: snmp/wsd/ipp/pdf/registry/service wiring | **DONE** — 4 fixes, 3 refutations (see log) |
| P2-1 | Gateway gate (typecheck/lint/test/build) | **DONE** — lint 0/0, tsc 0, vitest 722/0, build ok |
| P2-2 | 14 lint warnings | **DONE** — 0 warnings |
| P2-3 | Hard-coded API error strings scan | **DONE** — convention consistent, no change |
| P2-4 | Security/billing/DB passes | **DONE** — verified clean, no change |
| P3 | Odoo addon (py_compile/XML/pytest) | **DONE** — 136/136 pytest; 3 CI-red fixes |
| P4 | Cleanup (dead code, md collapse, PR triage) | **DONE** — verified nothing to do |
| P5 | Push + watch CI to green | **DONE** — all 5 workflows success |

### Pass 2 evidence so far (Go — FIRST local execution ever)
- `go build ./...` (linux): exit 0
- `go vet ./...`: exit 0
- `GOOS=windows GOARCH=amd64 go build ./...`: exit 0
- `go test -count=1 ./...`: 9 packages ok, 0 failures
  (cmd/agent has no test files — 10th package)
- `go test -race -count=1 ./internal/printer/`: ok (39s)
- `gofmt -l`: 1 hit (`stable_id_unicode_test.go` comment-indent,
  new-gofmt style) — fixed with `gofmt -w`, now clean.
- This executes the 11 previously-NEVER-RUN tests, including the NFC
  folding, SNMP identity pinning, WSD watchdog, and mutex-guard code.
