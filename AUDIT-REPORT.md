# Production-Grade Audit & Repair Report — yasser-gateway / oddo-print

Branch `arena/01a0c56b-oddo-print`, base commit `48b61aa`, audit date 2026-09-21.
Repairs land as commits `f9fb563` and `359f1f2` on top of the base.

---

## A. Executive Summary

Full-stack audit of the checked-out repository: Node/Next.js 16 gateway (`server.ts`, `src/**`), PostgreSQL schema + 58 drizzle migrations, Go Windows agent (`agent/**`), Tauri 2 desktop manager (`src-tauri/**`), and the Odoo 19 addon (`odoo_addons/print_gateway/**`).

**Six confirmed defects were found and repaired**, each with a regression test that demonstrably fails on the pre-repair code and passes after:

| ID | Severity | One-line summary |
|----|----------|------------------|
| F-01 | High (production crash) | Odoo config auto-sync sent the OWL client-side datapoint id (`datapoint_27`) as a record id — web client crash `Invalid ids list: datapoint_27` and a permanently stuck "Syncing" banner (observed live on the operator's instance 2026-09-21). |
| F-02 | High | The API request guard destroyed sockets of rejected requests mid-upload; clients received `ECONNRESET` instead of the documented 403/411/413/503 JSON. |
| F-03 | Medium | Authenticated `/api/*` responses left the process with **no** `Cache-Control` header, violating the documented "everything else stays `no-store`" contract (shared-cache poisoning exposure). |
| F-04 | Medium | A poison `checkout.session.completed` webhook (customer identity mismatch) 500-ed into an infinite Stripe retry loop — risking Stripe auto-disabling the webhook endpoint for **all** tenants. |
| F-05 | Low | Registration swallowed verification-email send failures in a bare `catch {}`; accounts could silently never receive their verification link. |
| F-06 | Low | Dead `TENANT_NOT_FOUND` → 404 mapping in the billing operation protocol (unreachable; error is only produced by routes with their own handlers). |

Everything else audited held up under adversarial verification: tenant isolation, claim-token fencing, CSRF/same-origin boundary, webhook signature enforcement, trial lifecycle, capability fail-closed routing, the Go agent's physical-outcome honesty (no false "printed"), the Odoo sync staleness fence, AES-256-GCM credential storage, the policy template sandbox, and the Tauri IPC allowlist.

**Verification executed in this environment (all green, exact numbers in §F/§G):** unit 456 (+1 by-design skip), integration 34/34 files & 235/235 tests, Python static contract suites 48/48, live adversarial E2E against a running gateway 43/43, Go build + vet + gofmt + 22 tests + `-race` on go1.26.6, `tsc --noEmit`, `eslint .`, `next build`.

**Not executable here (explicitly marked, covered by CI instead):** Windows-only Go suites, a live Odoo 19 runtime, real Stripe live-mode calls, and Windows installer/Tauri binary builds.

---

## B. Documentation Sources

Official sources consulted before every conclusion (version facts cross-checked against repo manifests, never assumed):

- **Next.js 16** — https://nextjs.org/blog/next-16 (GA 2025-10-21; Node ≥20.9, Turbopack default, `middleware.ts`→`proxy.ts`, async `cookies()`/`headers()`); https://versions.dev/modernize/nextjs/upgrade-to-nextjs-16 ; https://www.infoq.com/news/2025/12/nextjs-16-release/ — repo pin **next 16.3.4** is on the current line; no upgrade action.
- **ws** — https://security.snyk.io/package/npm/ws — pin **8.21.3**: latest, no known vulnerabilities (≤8.20.x affected by historical DoS).
- **Odoo 19** — https://www.odoo.com/documentation/19.0/developer/reference/backend/actions.html (ir.cron batch contract; `_commit_progress`) and https://www.odoo.com/documentation/19.0/contributing/development/coding_guidelines.html (no `cr.commit()` outside scheduled actions; no broad exception swallowing) — benchmarked against `print_job.py` cron (compliant: bounded batches + `_commit_progress`) and `gateway_config.py`.
- **Odoo 19 web client (root cause of F-01)** — fetched and verified from the official tree:
  - `web/static/src/model/relational_model/datapoint.js` — `this.id = getId("datapoint")`: every DataPoint's `.id` is a client-side `datapoint_N`, never a DB id.
  - `web/static/src/model/relational_model/record.js` — `get resId() { return this.config.resId; }`; `Record._save()` commits the creation's `resId` **before** `hooks.onRecordSaved` fires; `Record.load()` rejects changing `resId`.
  - `web/static/src/views/form/form_controller.js` — the stock `onRecordSaved` itself addresses the record via `this.model.root.resId`; `model.load({ resId })` is the sanctioned reload.
- **gorilla/websocket** — GO-2026-6278 / GHSA-w67g-5rqw-f597 (weak PRNG mask key) fixed in **v1.5.3** — the repo pin is the patched version.
- **Tauri 2** — https://v2.tauri.app/release/core/ — **2.11.5** (2026-07-01) is the current 2.11.x core release and includes the 2.11.1 security fixes (ACL enforcement for remote-origin IPC); the repo's explicit 22-command capability allowlist was verified against it. Docs.rs confirms `tauri 2.11.5` latest.
- **drizzle-orm** — https://github.com/drizzle-team/drizzle-orm/releases — 0.45.x on the active line; no advisories surfaced for 0.45.2.
- **Stripe** — 2026 integration guides (checkout.sessions.create semantics, raw-body signature verification, event-id idempotency, 2xx-for-permanent-failure practice) — benchmark for the webhook design; used to justify the F-04 repair (ack permanent conflicts instead of retrying forever).

Dependency versions were read from `package-lock.json`, `Cargo.toml`, and `agent/go.mod` — never assumed.

---

## C. Architecture Findings (verified-coherent core)

The system is a deliberate three-plane design; every plane was traced including failure paths:

1. **Gateway (this repo, Node/Next + PG + WS).** Odoo keys (`odoo_*`, scoped per document type) submit jobs; agents pair via 6-char codes and hold `<agentId>:<secret>` bearer tokens; browser sessions are argon2id + HttpOnly SameSite cookies with DB-backed revocation. Job delivery is a fenced lease machine: advisory transaction lock → live-count ceiling → `SELECT … FOR UPDATE SKIP LOCKED` eligibility → minted `gen_random_uuid()` claim token; **every** agent-attributable write is predicated on `(id, tenant, agent, status, claim_token IS NOT DISTINCT FROM token)` — TOCTOU-safe. Terminal states null the token; expiry stamps `PRINTED_POST_EXPIRATION` markers instead of lying. Maintenance sweeps use batched `SKIP LOCKED` with unknown-outcome markers; a 5-minute stale-printing fence converts vanished agents into explicit unknowns.
2. **Odoo addon.** Business intent stays in Odoo (`print_gateway.intent` idempotency ledger with claim tokens, 5-minute stale-lease recovery, admin-gated cron); durable job submission uses an independent-cursor outbox contract; activation sync is a fenced revision machine (monotonic `enabled_sync_revision`, dedicated `pending_sync_started_at` staleness fence of 300 s, dedicated-cursor outcome persistence, post-commit crash persistence, URL-migration shutdown state machine). The 19.0.2.6.0 migration backfills pending timestamps for rows stuck across upgrades. Credential storage is versioned AES-256-GCM with AAD binding and a no-plaintext-fallback migration.
3. **Go agent.** Local SQLite WAL ledger mirrors Gateway states but keeps the physical outcome distinct: `BeginPrint` is the pre-byte ownership fence (success is permanently terminal; unknown-outcome markers refuse reprint unless explicitly operator-opted; ledger-unavailable refuses zero bytes). Windows spooler transport treats `EndDocPrinter` failure as **unknown**, never success; partial writes carry `UNKNOWN_PARTIAL_DELIVERY`. 409/410/stale-claim ⇒ `ErrStaleClaim` (requeue-safe); other 4xx/5xx ⇒ hard stop without byte loss.
4. **Tauri desktop manager.** Explicit 22-command capability allowlist; gateway bearer only in Rust memory; origin-pinned request proxy with restricted-header blacklist, 64 KiB header budget, 8 MiB streamed body cap; child processes resolved from the bundle or System32 (no PATH hijack); termination requires image-name + creation-time identity match.

---

## D. Findings (ID · Severity · File · Function · Root cause · Impact · Evidence · Docs ref · Repair · Regression test · Verification)

### F-01 — Odoo auto-sync crashes with `Invalid ids list: datapoint_N` and sticks on "Syncing"
- **Severity:** High (production incident; user-reported on instance 68.221.27.248:8070, 2026-09-21 20:07 GMT).
- **File / Function:** `odoo_addons/print_gateway/static/src/js/gateway_config_auto_sync.js` · `FormController.onRecordSaved` (patch).
- **Root cause:** The patch used `record.id` as the record's database id for both the server RPC (`action_test_connection` / `action_retry_enabled_sync` with `[[record.id]]`) and the reload (`this.model.load({ resId: record.id })`). In Odoo 19, `DataPoint.constructor` sets `this.id = getId("datapoint")` — `record.id` is **always** the client-side `datapoint_N`, never the DB id. The persisted id is `record.resId` / `this.model.root.resId` (the accessor the stock FormController itself uses inside `onRecordSaved`).
- **Impact:** (a) the RPC browsed a nonexistent `datapoint_N` → sync never ran → `enabled_sync_state` stayed `pending` → banner stuck on "Syncing" (Python's 300 s staleness fence eventually escalates, but the crashed form never refreshed); (b) `model.load({resId:"datapoint_N"})` threw `Invalid ids list: datapoint_N` in `validatePrimitiveList` → uncaught promise error → Odoo error dialog, button flow aborted.
- **Evidence:** User-supplied production traceback (`FormController.onRecordSaved → _save → load → _loadRecords → webRead → validatePrimitiveList`, `Invalid ids list: datapoint_27`) reproduced byte-for-byte by the behavioral harness against the old code (`Invalid ids list: datapoint_1`).
- **Docs ref:** Odoo 19 `datapoint.js`, `record.js`, `form_controller.js` (§B).
- **Repair:** Address everything through `const resId = this.model.root.resId;`, guard `if (!resId || !this.model.root.data.gateway_api_key) return;` (unsaved record ⇒ nothing to sync), RPC with `[[resId]]`, reload with `model.load({ resId })`. `Record._save()` commits the creation resId before the hook, so first-time configuration creation also syncs.
- **Regression test:** `tests/test_odoo19_printing_static.py::test_gateway_config_auto_sync_uses_persisted_res_id_never_datapoint_id` (forbids `record.id`, requires the resId guard) + strengthened `…after_api_key_save` and `…activation_toggle_without_manual_refresh` (previously codified the bug). Behavioral harness (`/tmp/hook-behavior.mjs`) executes the shipped JS against Odoo-19-faithful fakes: 7/7 pass on fixed code; old code crashes with the production signature.
- **Verification:** `node --check`, static suites 48/48, harness 7/7, old-code discrimination run.

### F-02 — Rejected API requests RST the client before the response is delivered
- **Severity:** High (correctness of every guard rejection; breaks Odoo-side sync error handling that depends on reading JSON statuses).
- **File / Function:** `src/server/request-guard.ts` · `rejectRequest` (+ all four call sites in `guardApiRequest`).
- **Root cause:** On header-level rejection the guard wrote the JSON and then called `req.destroy()` synchronously; with a request body still in flight the kernel answered with TCP RST and the client's fetch rejected with `ECONNRESET` before/while reading the status (undici). Verified live: 3/3 oversized uploads → `ECONNRESET`, 0 responses read.
- **Impact:** Odoo's `_sync_enabled_state_to_gateway` (and any well-behaved client) cannot distinguish 413/503 from transport death; 503-capacity signals were invisible; error taxonomies broke.
- **Evidence:** Live reproduction (6.3 MiB declared body → RST) and a raw-socket regression test that floods 2 MiB after the header-level rejection.
- **Docs ref:** Standard HTTP server practice (Go `net/http` `maxPostHandlerReadBytes`, nginx `lingering_close`): drain a bounded window so the response is delivered, then tear down.
- **Repair:** Bounded lingering close — drain up to 16 MiB for at most 5 s (`unref`ed timer), teardown on end/error/close/budget. Response is fully delivered first; no unbounded stream is read; reservation semantics unchanged.
- **Regression test:** `tests/request-guard-http.test.ts::delivers the rejection response before releasing the socket (no RST mid-upload)` — fails with `read ECONNRESET` on old code; passes on new (20/20 file).
- **Verification:** live server: 5/5 oversized uploads now answer `413 {"success":false,"error":"REQUEST_BODY_TOO_LARGE"}`; whole file 20/20.

### F-03 — `/api/*` responses carried no `Cache-Control` (documented contract violated)
- **Severity:** Medium (shared-cache/heuristic caching of authenticated data).
- **File / Function:** `server.ts` (new `applyApiCacheControlDefault` in `src/server/api-defaults.ts`).
- **Root cause:** `src/lib/cache.ts` documents "every other data route stays `no-store`", but Next.js App Router stamps no `Cache-Control` on dynamic route handlers, and the custom server never set a default. Live probe: `/api/agents|jobs|printers|team/members|auth/me|odoo/keys|onboarding|settings` all returned **no** `Cache-Control` at all.
- **Impact:** Intermediate caches could legitimately cache per-user API responses (heuristic freshness), contradicting the documented security contract; only `/api/billing/plans` (public vary) and `odoo/*`/`metrics` opted out explicitly.
- **Docs ref:** MDN/Next.js caching semantics; the repo's own `cache.ts` contract.
- **Repair:** One boundary default in the custom server: `/api/*` responses get `Cache-Control: no-store` **lazily stamped at write-head/end**, so any route-provided policy already on the response wins (pre-setting the header in Next's Node adapter shadows route headers — that approach was tried and rejected because it silently privatized `/api/billing/plans`).
- **Regression test:** `tests/server-http-acceptance.test.ts`: no-store on `/api/live|health|agents` (real Next handler + guard), plus a DB-gated leg asserting `/api/billing/plans` keeps its exact `public, max-age=30, stale-while-revalidate=300, s-maxage=30`.
- **Verification:** Live: agents/jobs/printers/onboarding/settings/team/odoo-keys ⇒ `no-store`; billing/plans ⇒ public vary unchanged. Full unit suite green with and without `DATABASE_URL`.

### F-04 — Poison checkout webhook → 500 → infinite Stripe retry loop
- **Severity:** Medium.
- **File / Function:** `src/app/api/billing/webhook/route.ts` · checkout.session.completed handler.
- **Root cause:** `if (current?.stripeCustomerId && customerId && current.stripeCustomerId !== customerId) throw new Error("Checkout customer identity conflict")` — a **permanent** mismatch, surfaced as 500. The generic identity-conflict path in the same file already handles its (identical) condition by marking the event processed + auditing + acking `{received:true, ignored:true}`.
- **Impact:** Stripe retries a never-succeeding event with backoff for days (log spam, event table churn) and prolonged failure rates can trip Stripe's endpoint auto-disable — silently stopping **all** tenants' billing webhooks.
- **Evidence:** Code path + regression test (old route: test fails expecting 500; new: 200 ignored).
- **Docs ref:** Stripe webhook guidance — return non-2xx only for transient failures; permanent failures should be recorded and acked (2xx) with alerting.
- **Repair:** Mirror the in-file conflict pattern: mark `billing_events.processed_at` (with bound tenant), audit `billing.checkout_customer_conflict`, return `{kind:"ignored"}` ⇒ HTTP 200. Bound billing identity is never mutated.
- **Regression test:** `tests/billing-webhook.test.ts` case 11 — 200/ignored, event marked processed, subscription untouched (customer/status/checkoutStatus), audit row present. Fails on pre-repair code (500).
- **Verification:** file 11/11; focused billing suites 28/28; full integration 235/235.

### F-05 — Registration swallowed verification-email failures
- **Severity:** Low.
- **File / Function:** `src/app/api/auth/register/route.ts` · POST (email-send `catch {}`).
- **Root cause:** Bare `catch { }` around `sendTransactionalEmail`; a provider outage created accounts whose verification link never arrives, with zero operator trace (user stuck pre-verification).
- **Impact:** Silent support burden; violates the "no swallowed errors" contract. Response semantics must stay generic 202 (enumeration resistance, email-outage resilience) — so the repair is observability, not behavior change; recovery path is `/api/auth/resend-verification`.
- **Repair:** `logError("auth.register.verification_email_failed", …)` in the catch.
- **Regression test:** `tests/test_security_contracts.py::test_registration_email_failure_is_observable_not_swallowed` (fails on old code).
- **Verification:** static suites 48/48; typecheck/lint clean.

### F-06 — Dead `TENANT_NOT_FOUND` mapping in the billing operation protocol
- **Severity:** Low (dead code; misleads readers into assuming a contract that doesn't exist).
- **File / Function:** `src/lib/billing-operation.ts` · claim-transaction catch.
- **Root cause:** Nothing in `runBillingOperation` raises `TENANT_NOT_FOUND`; an absent tenant yields the shared `{kind:"missing"}` 409 outcome. The error name is only produced by checkout/onboarding/team routes, which have their own handlers.
- **Repair:** Removed the unreachable catch branch (behavior-preserving: unknown errors propagated before and after); state explicitly typed via `BillingOperationState`.
- **Regression/verification:** typecheck, lint, unit 456, integration 235, focused cancel/resume-related suites 28/28 — all green; no behavior change possible by construction (the branch was unreachable).

### Environmental items investigated and cleared (not repo defects)
- Multi-instance integration failure root-caused to a missing `.next` production build; after `npm run build`, `multi-instance-gateway` passes and full integration runs include it (34/34).
- Python static suites failed only for a missing `cryptography` wheel in the sandbox; after install, 48/48.
- One unit skip appears only when `DATABASE_URL` is unset (DB-backed acceptance leg, `describe.skipIf` by design); with a database it runs and passes.

---

## E. Repairs Applied (commits on `arena/01a0c56b-oddo-print`)

1. `f9fb563` — F-02 (bounded lingering-close drain + regression test), F-03 (`applyApiCacheControlDefault` + acceptance tests), F-01 (resId repair + strengthened/new static contract tests).
2. `359f1f2` — F-04 (webhook ack-and-audit + regression test 11), F-05 (logError + static contract test), F-06 (dead mapping removal).

No test was weakened; every changed assertion was strengthened (two static tests that had codified F-01 now forbid the bug pattern). No pins were upgraded.

---

## F. Functional Verification (exact numbers, this environment)

| Layer | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Build | `npm run build` | exit 0 (~26 s) |
| Unit suites | `vitest --config vitest.unit.config.mts` | **66 files / 456 passed / 1 skipped** (skip = DB-gated acceptance leg without `DATABASE_URL`; passes with it — file verified 7/7 with DB) |
| Integration suites | `RUN_MULTI_INSTANCE_TEST=1 vitest --config vitest.integration.config.mts` (PG 17.9 local) | **34/34 files, 235/235 tests, 0 failed** (includes multi-instance, tenant isolation, ws races, billing webhook + concurrency, migration upgrade, job-status PG concurrency) |
| Python static contracts | `python3 -m pytest tests/test_odoo19_printing_static.py tests/test_security_contracts.py tests/test_final_security_hardening.py tests/test_gateway_activation_robustness.py` | **48 passed** |
| Live adversarial E2E | scripted 43-check suite against the running gateway (§G) | **43 passed / 0 failed** |
| Go build | `go build ./...` (go1.26.6, GOPROXY=direct) | OK |
| Go vet / gofmt | `go vet ./...`, `gofmt -l .` | clean |
| Go tests (linux-runnable) | `go test -race -count=1 ./internal/queue ./internal/payload ./internal/diag ./internal/storage` | **4/4 suites, 22 test functions PASS under `-race`** |
| CI tripwire | `tests/ci-tripwire.check.ts` (integration entry) | passes as part of the 34/34 |

Test classification is canonical in `vitest.test-groups.mts`: 34 integration entries (33 `*.test.ts` + `ci-tripwire.check.ts`); everything else is unit-classified.

---

## G. Live Verification (executed vs not-executable)

**Executed live** (custom server on Node 24.19, tsx, PG 17.9 at 127.0.0.1:5432; 43-check adversarial suite):
- Registration → verification → session; onboarding trial activation; duplicate-trial refused (409).
- Agent creation → pairing registration (secret returned once; code replay rejected); unauthenticated heartbeat 401; heartbeat printer upsert (with ownership-conflict skip semantics).
- Odoo key issuance (raw shown once; list redacts), configuration enable with fenced revisions (stale revision cannot regress; live `applied:false`).
- Print submission: accept, idempotent replay (same job), idempotency conflict (409), unknown printer (404), oversized body (413 — post-repair), PDF-smuggled-as-escpos rejected.
- Agent claim lifecycle: claim token minted; forged token ⇒ `STALE_CLAIM` 409; `claimed→success` rejected; `claimed→printing→success` with `physicalOutcome:"printed"`; post-terminal writes 409.
- Cross-tenant isolation: B cannot see A's agents/jobs/timeline; B's agent cannot mutate A's job; B's Odoo key cannot target A's printer (404s).
- CSRF: cross-site cookie mutation rejected 403 at the guard; origin enforcement on cookie mutations.
- Billing: unsigned/forge-signed webhooks 400 with **no** persisted state; checkout without Stripe → 503 `STRIPE_NOT_CONFIGURED`; portal without subscription → 409.
- Entitlement gate: expired trial blocks new job submissions (403).
- Cache: post-repair `no-store` on all data routes; public vary preserved on `/api/billing/plans`.
- Expired platform-trial manager login gating and misc 4xx shapes (weak password, bad tokens, PUT 405).

**Not executable in this sandbox — explicitly marked unexecuted (CI-covered):**
- A live Odoo 19 server (addon installed): verified via 48 static contract tests + source-level Odoo 19 API verification; CI job `odoo:19.0` installs and tests the addon for real.
- Real Stripe API calls (checkout sessions/portal in live mode): webhook side verified with locally-signed events incl. concurrency tests; API side follows the same `stripeRequest` + idempotency-key protocol.
- Windows-specific Go suites (`spooler_windows`, `usb_windows`, service lifecycle): linux build excludes `_windows` files; CI `build-windows.yml`/go job run them on Windows runners. Agent/config/printer/integration Go packages failed **at module-graph setup** here because `gopkg.in`/`golang.org` meta endpoints are unreachable from the sandbox (not code failures); build/vet/gofmt and 4 suites under `-race` are green.
- Tauri desktop binary / NSIS installer: not buildable here (Rust/Windows); configuration, capabilities, and Rust command surface statically audited.
- Multi-instance gateway across separate hosts: run locally as 2 instances against one PG (passes); not exercised across real networks.

---

## H. Remaining Risks

1. **Odoo runtime behavior of F-01's fix** is verified by contract tests + an Odoo-19-faithful behavioral harness, not by a live Odoo browser session here. The repair uses exactly the stock controller's own accessor; residual risk is low but a smoke test on the operator's instance (reload the addon assets, toggle the switch) is recommended — the UI must flip "Syncing" → "Active"/"Action needed" without a dialog.
2. **Stripe endpoint health:** if the repaired webhook had been running un-repaired long enough for Stripe to auto-disable the endpoint, re-enabling must be done manually in the Stripe dashboard after deploying this fix.
3. **Go suites blocked by sandbox egress** (module-graph meta fetches): their correctness signal here is build+vet+race on the linux subset; the full suite runs in CI with open network.
4. **Windows printing hardware path** remains exercised only in CI unit form; physical spooler behavior (`EndDocPrinter` semantics) is correctly conservative by construction but not hardware-verified here.
5. **Operational:** `TRUST_PROXY` must be enabled behind the edge proxy for IP-scoped auth rate limiting (documented warning exists in code); `GATEWAY_JWT_SECRET` must be ≥32 chars in production (enforced fail-closed).

---

## I. Final Repository State

- Branch `arena/01a0c56b-oddo-print`, three commits ahead of base `48b61aa`: `f9fb563`, `359f1f2` (+ this report).
- Changed files: `server.ts`, `src/server/api-defaults.ts` (new), `src/server/request-guard.ts`, `src/app/api/billing/webhook/route.ts`, `src/app/api/auth/register/route.ts`, `src/lib/billing-operation.ts`, `odoo_addons/print_gateway/static/src/js/gateway_config_auto_sync.js`, `tests/request-guard-http.test.ts`, `tests/server-http-acceptance.test.ts`, `tests/billing-webhook.test.ts`, `tests/test_odoo19_printing_static.py`, `tests/test_security_contracts.py`.
- All available verification layers green at final state: typecheck, lint, build, unit (456|1 env-skip), integration (34 files/235), Python static (48), live E2E (43), Go build/vet/fmt/tests+race (22), plus the Odoo-JS behavioral harness (7/7).
- No dependency pins changed. No tests skipped or weakened. Environment gaps (Odoo runtime, Windows runners, live Stripe, blocked Go hosts) are explicitly marked as CI-covered rather than claimed.
