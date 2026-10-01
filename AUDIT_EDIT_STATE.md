# Audit edit state — Odoo Print Gateway

Branch: `arena/01a0f87e-oddo-print`
Last commit: `67e1614` — `fix(i18n): Arabic plural zero forms, SSR locale, RTL hydration, lifecycle labels`
Updated: 2026-10-02

> Full chronological history lives in the append-only `AUDIT_LOG.md`.

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

## RESUME HERE

Sub-task B is complete and committed as `67e1614`. The remaining step is to push
the commit and refresh PR #111. If continuing beyond that, the highest-value
follow-up is a manual visual RTL pass in a real browser, since none of the
rendering could be verified in this sandbox.
