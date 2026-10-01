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

## RESUME HERE

Sub-task B is complete, pushed, and PR #111 is refreshed.

Sub-task C has 6 fixes across 2 rounds, all committed and pushed. Before
continuing:

1. `go build ./...`, `go vet ./...` and `go test -race ./...` on a machine with
   Go — the first thing to do, because nothing here was ever compiled. The
   data-race fix (round 2, item 6) is specifically designed to be proven by
   `-race` and has not been.
2. Then the files still un-audited: `ipp.go`, `ipp_discovery.go`,
   `pdf_windows.go`, `registry.go`, `network_discovery.go`,
   `discovery_extended.go`.
3. Real-hardware verification for anything touching SetupAPI, SNMP, WSD,
   discovery accuracy and ESC/POS raster output.

Highest-value remaining work outside sub-task C: a manual visual RTL pass in a
real browser at 1280px and 390px, EN and AR, since none of the rendering could
be verified in this sandbox.
