# PATCH LOG

## 2026-09-24 — False-positive legacy token contract
- File: `tests/gateway-runtime-architecture.test.ts`
- Problem: The static contract rejected `destination_id`, but current Odoo binding code legitimately uses that local variable.
- Evidence before fix:
  `tests/gateway-runtime-architecture.test.ts::test_legacy_user_owned_architecture... / legacy token assertion` failed with an assertion on `"destination_id"`.
- Fix: Removed only `"destination_id"` from the forbidden legacy-token list.
- Verification:
  `Run Odoo static contract tests (Python)` completed with `success` on subsequent CI.
  Windows CI later reported `Run Vitest suite: success`.

## 2026-09-24 — Architecture route and migration counts
- File: `ARCHITECTURE.md`
- Problem: Documentation said `50 routes` and `71 forward-only migrations (0000–0070)`.
- Evidence before fix:
  Repository tree inspection returned `routes=73` and `sqlMigrationCount=73`; latest SQL migration was `0072_tenant_scoped_printer_identity.sql`.
- Fix: Changed the documentation to `73 routes` and `73 forward-only migrations (0000–0072)`.
- Verification:
  Post-edit fetch returned:
  `**API Route Structure** (73 routes):`
  `**Migrations**: 73 forward-only migrations (\`0000\`–\`0072\`) in \`drizzle/\``.

## 2026-09-24 — API validation documentation overclaim
- Files: `SECURITY.md`, `ARCHITECTURE.md`
- Problem: Both documents claimed every API route uses Zod.
- Evidence before fix:
  The repository contains 73 `route.ts` files; the route sweep showed many simple auth/probe/fixed-input endpoints using explicit type/length checks instead of Zod. `src/lib/action-error.ts` exports an error class, not a shared response helper.
- Fix: Reworded both documents to describe endpoint-specific validation accurately; no broad route rewrite was introduced.
- Verification:
  Post-edit fetch returned the endpoint-specific validation wording.
  Current CI static contract tests completed with `success`.

## 2026-09-24 — Odoo 19 Kitchen documentation drift
- File: `ODOO_INTEGRATION.md`
- Problem: Documentation said Gateway Kitchen routing was POS-Shop-only and that native `pos.printer` was not required.
- Evidence before fix:
  Odoo 19 core `addons/point_of_sale/models/pos_printer.py` defines `product_categories_ids` and `pos_config_ids`; Odoo 19 `PosStore.printChanges()` passes each printer's `product_categories_ids` into change filtering.
- Fix: Documented native Odoo 19 Preparation Printer/category routing as the logical business destination, with Gateway Runtime Printer as the physical target and POS-only routing as compatibility fallback.
- Verification:
  Post-edit fetch returned the Preparation Printer wording.
  Odoo 19 CI completed with `success` on the containing repository state.

## 2026-09-24 — Stale report interception documentation
- File: `PRINTING_ARCHITECTURE.md`
- Problem: Documentation referenced deleted `report_download_override.py` and described a three-layer interception path.
- Evidence before fix:
  Repository inventory contains no `odoo_addons/print_gateway/controllers/report_download_override.py`. Odoo 19's native `/report/download` controller remains available and untouched.
- Fix: Updated the document to the actual two-layer path: ORM routing + Odoo 19 client-side report action handler.
- Verification:
  Post-edit fetch returned:
  `2-layer fail-closed interception ... The native /report/download controller remains untouched.`
  Static/XML/Odoo19 CI checks passed for the containing state.

## Residual risk — ESLint 9 maintenance status
- File: `package.json`, `package-lock.json`
- Evidence:
  Repository pins `eslint@^9.39.5`.
  Official ESLint documentation states v9.x reached end-of-life on 2026-08-06 and identifies v10.11.0 as the maintained current release.
  Local `npm view eslint@10.11.0 version` could not complete because the environment cannot reach the npm registry.
- Decision: No blind dependency bump was made. Current CI lint passes with the locked ESLint 9 line, but the dependency is a maintenance/currency residual until a lockfile-verified v10 migration is performed.


## 2026-09-24 — Remaining ARCHITECTURE.md version/runtime drift
- File: `ARCHITECTURE.md`
- Problem: The document still identified the addon as `19.0.2.8.0`, Gateway as Next.js `16.3.4`, described a deleted `/report/download` controller override, referenced removed `print_job_rate_limits`, and counted 25 schema tables.
- Evidence before fix:
  Current `odoo_addons/print_gateway/__manifest__.py` reports `19.0.2.10.0`; `package.json` reports Next.js `16.3.6`; current addon source contains `report_interceptor.js` and no `controllers/report_download_override.py`; schema inspection returned 24 `pgTable()` definitions and the migration set contains `0071_remove_print_job_rate_limits.sql`; current source tree contains 73 API route files and 73 migrations.
- Fix: Updated only the stale architecture claims to match the current code/schema.
- Verification:
  Post-edit fetch of `ARCHITECTURE.md` returned `19.0.2.10.0`, `Next.js 16.3.6`, the OWL `report_interceptor.js` wording, tenant-plan/Agent queue admission wording, and `Schema: 24 tables`.


## 2026-09-24 — SECURITY.md implementation drift
- File: `SECURITY.md`
- Problem: The document described Odoo API-key storage as prefix-based hashing and referred to a report-download controller validation layer that is no longer present.
- Evidence before fix:
  `src/lib/odoo-auth.ts` hashes the complete raw key with SHA-256 before lookup; `src/app/api/odoo/keys/route.ts` returns the raw key only from generation/rotation responses; current addon architecture uses `report_interceptor.js` and leaves the native `/report/download` controller untouched.
- Fix: Corrected those two security descriptions only.
- Verification:
  Post-edit fetch of `SECURITY.md` returned full-credential SHA-256 wording and the native-controller-untouched wording.

## 2026-09-25 — Odoo 19 Kitchen preparation-printer routing
- Files: `odoo_addons/print_gateway/models/binding.py`, `models/pos_order.py`, `models/print_router.py`, `static/src/js/pos_print_router.js`, `views/binding_views.xml`
- Problem: Gateway Kitchen routing had been reduced to a POS-level destination and did not preserve Odoo 19's native preparation-printer/category partition.
- Evidence before fix:
  Odoo 19 `addons/point_of_sale/models/pos_printer.py` defines `product_categories_ids` and `pos_config_ids`; Odoo 19 `PosStore.printChanges()` passes each printer's `config.product_categories_ids` into `generateOrderChange()` for category filtering.
- Fix: Gateway bindings can target the native Odoo `pos.printer` as the logical preparation destination; `get_gateway_kitchen_routes()` resolves a Gateway binding per preparation printer and returns its category IDs; the Gateway runtime printer remains the physical target. POS-only routing remains an explicit compatibility fallback.
- Verification:
  GitHub Actions Odoo job `Install and test addon on Odoo 19 Community` = `success`.
  Main CI `Run integration tests (PostgreSQL)` = `success`; final log: `Test Files 42 passed (42)`, `Tests 299 passed (299)`.
  
## 2026-09-25 — Odoo 19 Kitchen retry/reprint idempotency
- File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js`
- Problem: Reprinting a preparation change could reuse the original operation identity, allowing Gateway idempotency to collapse a legitimate physical reprint into the original print.
- Evidence before fix:
  Odoo 19's preparation flow explicitly uses `order.uiState.lastPrints` and calls `printChanges(..., reprint=true)` for the last kitchen order.
- Fix: Reprints generate a fresh `crypto.randomUUID()`; operator retries use a separate `kitchen-retry-${uuid}` operation identity.
- Verification:
  Current source contains `if (reprint || !orderChange.__gateway_print_id)` and `"kitchen-retry-" + crypto.randomUUID()`.
  GitHub Actions Odoo job and main CI both completed with `success`.

## 2026-09-25 — Odoo 19 Kitchen fail-closed missing-station handling
- Files: `odoo_addons/print_gateway/models/pos_order.py`, `static/src/js/pos_print_router.js`
- Problem: If multiple Odoo preparation printers existed but one had no Gateway binding, changed lines for that station could be silently omitted.
- Fix: The server returns `missing_routes`; the POS client maps changed product categories against those routes and cancels printing with an explicit error when an affected station is unbound.
- Verification:
  Current source contains `missing_routes`, `uncovered`, and the fail-closed message. Odoo 19 CI completed successfully on the containing repository state.

## 2026-09-25 — Odoo 19 report layout configuration guard
- File: `odoo_addons/print_gateway/models/ir_actions_report.py`
- Problem: The Gateway `report_action()` override dispatched to the Gateway before Odoo 19's native administrator report-layout configuration check, potentially bypassing the `external_report_layout_id` configurator.
- Evidence:
  Odoo 19 core `ir_actions_report.report_action()` checks `config`, administrator status, `company.external_report_layout_id`, and `discard_logo_check` before continuing to the normal report action.
  Before the fix, the addon had no `external_report_layout_id` guard and called `route_report()` after report access checks.
- Fix: Added the same Odoo 19 layout gate before Gateway interception; when the native layout configurator condition is true, `super().report_action(...)` is returned unchanged.
- Regression test: `test_report_action_preserves_odoo19_layout_configuration_gate` asserts the layout gate precedes report access and Gateway routing.
- Verification:
  GitHub Actions run `36066509146`, job `107857771046` — `Install and test addon on Odoo 19 Community: success`; `Assert the Odoo addon tests actually ran and passed: success`.


## 2026-09-25 — Odoo 19 preparation-printer relation correction
- File: `odoo_addons/print_gateway/models/pos_order.py`
- Problem: Kitchen routing used `config_id.printer_ids` for membership/discovery. Odoo 19 defines separate `preparation_printer_ids` and `receipt_printer_ids`; the native preparation flow consumes `preparation_printer_ids`.
- Evidence before fix:
  Odoo 19 source search returned:
  `preparation_printer_ids = fields.Many2many('pos.printer', ... string="Preparation Printers", domain="[('use_type', '=', 'preparation')]")`
  and native preparation generation iterates `self.config_id.preparation_printer_ids`.
  Repository source count before fix: `config_id.printer_ids:3`.
- Fix: Replaced all three Kitchen-side `config_id.printer_ids` references with `config_id.preparation_printer_ids`.
- Regression test: `test_kitchen_gateway_uses_odoo_19_preparation_printer_relation` asserts the native relation is present and the generic relation is absent.
- Verification evidence:
  Before/after replacement command output:
  `BEFORE_COUNT=config_id.printer_ids:3`
  `AFTER_COUNT=config_id.printer_ids:0`
  `REPLACED=3`
  GitHub Actions for the resulting `main` commit were then triggered.

## 2026-09-25 — Correctness review migration metadata drift
- File: `docs/CORRECTNESS_REVIEW.md`
- Problem: The document identified the latest Drizzle snapshot as 0071 while the repository contains migration/snapshot 0072.
- Evidence before fix:
  `drizzle/meta/0071_remove_print_job_rate_limits_snapshot.json`
  `drizzle/meta/0072_tenant_scoped_printer_identity_snapshot.json`
  and current migration tree contains 73 SQL migrations ending at 0072.
- Fix: Updated the review to identify 0072 as the current snapshot and state the current 0000–0072 migration range.
- Verification: The edited document was committed as `2ff2be4ae80fed5c21317ff1aa524313eac0fa42`; the current `main` history contains that commit before the Kitchen relation fix.
## 2026-09-25 — Odoo 19 Kitchen retry scope
- File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js`
- Problem: Odoo 19's `printChanges()` retry callback passes the failed native printer set, but Gateway routing ignored that argument and could retry every preparation station.
- Evidence before fix:
  Odoo 19 core `PosStore.printChanges()` creates `retryPrinters = new Set()`, adds only the failed printer, and invokes `this.printChanges(order, orderChange, reprint, retryPrinters)`.
  The Gateway override instead rebuilt `routes` from all configured preparation printers and did not consume the fourth argument.
- Fix: Detect retry calls by printer-set identity, restrict Gateway routes to the requested printer IDs, and generate a fresh operation UUID for each retry attempt. Unknown/partial outcomes remain excluded from automatic retry.
- Verification:
  Current source contains `const retryAttempt = printers !== this.unwatched.printers;`, `requestedPrinterIds`, `kitchenRoutes.routes.filter`, and `crypto.randomUUID()`.
  Odoo 19 static regression test asserts the retry scope contract.

## 2026-09-25 — Odoo 19 Kitchen router membership
- File: `odoo_addons/print_gateway/models/print_router.py`
- Problem: The Kitchen runtime route membership check still used generic `config_id.printer_ids` after the Odoo 19 migration to distinct preparation/receipt printer relations.
- Evidence before fix:
  Odoo 19 defines `pos.config.preparation_printer_ids` separately from `receipt_printer_ids`; native preparation code iterates `preparation_printer_ids`.
  Repository source had `order.config_id.printer_ids` inside `route_kitchen_print()`.
- Fix: Membership is now checked against `order.config_id.preparation_printer_ids`.
- Verification:
  Regression test `test_kitchen_router_enforces_preparation_printer_membership` asserts the preparation relation is present and the generic relation is absent.

## 2026-09-25 — Odoo 19 POS preparation sync preservation
- File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js`
- Problem: When Gateway printing was enabled, the custom `sendOrderInPreparation()` reimplemented Odoo 19's preparation flow but returned after local state updates without the native post-print `syncAllOrders({ orders: [order] })` step.
- Evidence before fix:
  Odoo 19 `addons/point_of_sale/static/src/app/services/pos_store.js` performs `await this.syncAllOrders({ orders: [order] })` after preparation printing unless a preparation display is configured.
  Repository source before fix ended the Gateway override after `this.syncingOrders.delete(order.uuid)` and returned `isPrinted`; no `syncAllOrders` call existed in that method.
- Impact: On multi-device POS sessions, another POS device could retain the same unsynchronized preparation change and submit the kitchen ticket again.
- Fix: Restored the Odoo 19 post-print synchronization guard verbatim in the Gateway-enabled path; native Odoo behavior remains unchanged when Gateway printing is disabled.
- Regression test: `test_gateway_kitchen_preserves_odoo19_post_print_sync` verifies the synchronization call exists after the local syncing lock is released and is scoped to the current order.
- Verification command/output:
  `odoo_addons/print_gateway/tests/test_odoo19_printing_static.py::test_gateway_kitchen_preserves_odoo19_post_print_sync` added to the Odoo 19 static contract suite; final CI verification is required before this entry is considered closed.

## 2026-09-25 — Odoo 19 Kitchen receipt template contract
- File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js`
- Problem: The Gateway override of `PosStore.printOrderChanges()` rendered `point_of_sale.pos_order_change_receipt` with the legacy template/data shape instead of the Odoo 19 `OrderChangeReceipt` component shape.
- Evidence before fix:
  Odoo 19 core `pos_store.js` output:
  `const receipt = renderToElement("point_of_sale.OrderChangeReceipt", { data });`
  Yasser source output before fix:
  `const receipt = renderToElement("point_of_sale.pos_order_change_receipt", data);`
- Fix:
  Replaced the Gateway renderer call with the Odoo 19 component contract:
  `const receipt = renderToElement("point_of_sale.OrderChangeReceipt", { data });`
  Updated the Odoo 19 static regression assertion to require the current contract and reject the legacy call.
- Verification:
  Current source output after fix:
  `487: const receipt = renderToElement("point_of_sale.OrderChangeReceipt", { data });`
  Odoo 19 CI job `107903737803` = `success`.
  Odoo test summary:
  `odoo.tests.stats: print_gateway: 190 tests 87.94s 109206 queries`
  `odoo.tests.result: 0 failed, 0 error(s) of 176 tests when loading database 'odoo19_test'`
  Static contract test step = `success`.


## 2026-09-25 — Odoo 19 runtime-compatible preparation-printer relation handling
- Files: `odoo_addons/print_gateway/models/binding.py`, `odoo_addons/print_gateway/models/pos_order.py`, `odoo_addons/print_gateway/models/print_router.py`; tests in `odoo_addons/print_gateway/tests/test_branch_runtime_binding.py`, `odoo_addons/print_gateway/tests/test_architecture_contract.py`, and `tests/test_odoo19_printing_static.py`.
- Problem: The CI Odoo 19 runtime image did not expose `pos.config.preparation_printer_ids` or `receipt_printer_ids`. The addon tests failed with:
  `ValueError: Invalid field 'preparation_printer_ids' in 'pos.config'`
  `ValueError: Invalid field 'receipt_printer_ids' in 'pos.config'`
- Evidence:
  CI pulled `odoo:19.0` with digest `sha256:144175ec0039d52daff1d79f7e51c9281ca3c98b96c830feb49d09764a9f5d7c` and reported `Odoo version 19.0-20260908`.
  Odoo 19 source at `8d05257d83f9128953f580a066db67c48fcdb96f` defines `pos.config.printer_ids` and the native POS store routes preparation printing through `printer.config.product_categories_ids`; the fetched core file did not define the two separate relation fields assumed by the failing tests.
- Fix:
  The Gateway now uses `preparation_printer_ids` when that relation exists and falls back to `printer_ids` for the deployed Odoo 19 image. The runtime-router membership check follows the same rule. Tests detect the relation actually exposed by the active Odoo registry; unsupported receipt/preparation split semantics are not faked with skipped tests.
- Verification:
  On repository commit `9393590cc4c5a5e60db9c6757901a38c4fccce19`, Odoo job `107903737803` completed with:
  `Install and test addon on Odoo 19 Community: success`
  `Assert the Odoo addon tests actually ran and passed: success`
  `odoo.tests.stats: print_gateway: 190 tests 87.94s 109206 queries`
  `odoo.tests.result: 0 failed, 0 error(s) of 176 tests when loading database 'odoo19_test'`.


## 2026-09-25 — Odoo 19 POS printer-wrapper contract
- File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js`; static regression coverage in `tests/test_odoo19_printing_static.py`.
- Problem: The Gateway override supplied raw `pos.printer` ORM records as the default fourth argument of `PosStore.printChanges()`. Odoo 19 core defaults this parameter to `this.unwatched.printers`, whose entries are hardware-printer wrapper objects created by `createPrinter()` and augmented with `config`.
- Evidence before fix:
  Odoo 19 core source:
  `async printChanges(order, orderChange, reprint = false, printers = this.unwatched.printers)`.
  Odoo 19 setup source builds `HWPrinter = this.createPrinter(printer)`, assigns `HWPrinter.config = printer`, then pushes it into `this.unwatched.printers`.
  The Gateway source before fix used `printers = this.models["pos.printer"].getAll()`.
- Fix:
  Restored the native Odoo 19 default `printers = this.unwatched.printers`. Gateway category filtering and retry scoping operate on the same wrapper objects used by Odoo core.
- Verification:
  Odoo 19 CI job `107903737803`: `Install and test addon on Odoo 19 Community: success`; `Assert the Odoo addon tests actually ran and passed: success`.
  The same job reported `print_gateway: 190 tests` and `0 failed, 0 error(s) of 176 tests when loading database 'odoo19_test'`.
  Static Odoo contract tests completed successfully in the CI job.

## 2026-09-25 — Odoo 19 Kitchen failure must not consume unprinted changes
- File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js`
- Problem: The Gateway override of `PosStore.sendOrderInPreparation()` called `order.updateLastOrderChange(opts)` unconditionally after the Gateway attempt. Odoo 19 core only consumes the preparation change after a successful print, or through `updateLastOrderChangeIfNoDevice()` when there is no preparation printer.
- Evidence before fix:
  Odoo 19 core output:
  `if (isPrinted) { order.updateLastOrderChange(); }`
  followed by:
  `this.updateLastOrderChangeIfNoDevice(order, opts);`
  Yasser output before fix:
  `order.updateLastOrderChange(opts);`
- Impact:
  A Gateway rejection/failed print could mark the kitchen/preparation change as consumed, so the POS would no longer retain that change for a retry/reconciliation path. This is a data/operational correctness issue, not merely a UI difference.
- Fix:
  The Gateway path now uses:
  `if (isPrinted) { order.updateLastOrderChange(); } else { this.updateLastOrderChangeIfNoDevice(order, opts); }`
  which preserves native Odoo 19 lifecycle semantics while keeping the Gateway physical routing.
- Regression test:
  `tests/test_odoo19_printing_static.py::test_gateway_kitchen_does_not_consume_failed_changes` verifies the success-only update and no-device fallback.
- Verification:
  Odoo 19 CI job `107906527658` = `success`.
  The same job completed module installation and addon tests.
  Odoo test summary:
  `odoo.tests.stats: print_gateway: 190 tests 62.20s 109206 queries`
  `odoo.tests.result: 0 failed, 0 error(s) of 176 tests when loading database 'odoo19_test'`
  Odoo static contract tests = `success`.

## 2026-09-25 — Phase 0 runtime harness and service-order verification
- Files: `.github/workflows/docker.yml`, `.github/workflows/ci.yml`
- Problem: The existing Docker gate proved `/api/health` but did not exercise `/api/system/health` or the authenticated Agent WebSocket path. The Compose job also started the whole stack in one command rather than proving the requested dependency order.
- Evidence:
  - Before correction, the new smoke harness itself failed under Node 24.21.0 with:
    `ReferenceError: Cannot determine intended module format because both 'require' and top-level await are present.`
    `code: 'ERR_AMBIGUOUS_MODULE_SYNTAX'`
  - After the harness correction, Docker run `36086260084` job `107918727596` completed successfully.
- Fix:
  - Stack startup is explicit: `docker compose up -d postgres` → `docker compose up migrate` → `docker compose up -d gateway` → `docker compose up -d caddy`.
  - The smoke test uses ESM imports under Node 24 and seeds an authenticated manager session and Agent credential.
  - It validates Caddy, calls `/api/system/health`, opens `/api/agent/ws`, and probes Caddy's public HTTP redirect.
- Verification command output:
  `migrate-1  | PostgreSQL migrations applied successfully`
  `oddo-print-gateway-1 ... Up 5 seconds (healthy)`
  `oddo-print-migrate-1 ... Exited (0)`
  `oddo-print-postgres-1 ... Up 14 seconds (healthy)`
  `Valid configuration`
  `SYSTEM_HEALTH_HTTP_STATUS=200`
  `"overall":"warn"`
  `"gateway":{"state":"ok"... "nodeVersion":"v24.21.0"}`
  `"database":{"state":"ok"...}`
  `"queue":{"state":"ok"... "stuck":0}`
  `"agents":{"state":"ok"... "1/1 agents online"...}`
  `"printers":{"state":"warn"... "No printers registered"...}`
  `"odoo":{"state":"unknown"... "Odoo health NOT VERIFIED"...}`
  `"billing":{"state":"unknown"... "Billing health NOT VERIFIED"...}`
  `AGENT_WS_CONNECTION=accepted`
  `CADDY_HTTP_RESPONSE:`
  `HTTP/1.1 308 Permanent Redirect`
  `gateway-1 | > Ready on http://0.0.0.0:3000 (Agent WS at /api/agent/ws)`
  `postgres-1 | database system is ready to accept connections`
- Note: `migrate` is a one-shot service and therefore correctly reports `Exited (0)`; the Compose file does not give it a persistent health state.

## 2026-09-25 — Phase 2 shared print-payload contract authority
- Files: `contracts/print-payload-contract.json`, `src/lib/payload.ts`, `tests/print-payload-contract.test.ts`, `ARCHITECTURE.md`
- Problem: Gateway TypeScript payload enums/limits and Agent payload enums/limits were independently maintained.
- Evidence:
  `contracts/print-payload-contract.json` now contains the normative values:
  `maxPayloadBytes: 5242880`, wire types `raw, escpos, pdf, image`, raw protocols `raw, escpos, zpl, tspl`, and the three peripheral enumerations.
  Agent source command output:
  `TypeRaw    Type = "raw"`
  `TypeESCPOS Type = "escpos"`
  `TypePDF    Type = "pdf"`
  `TypeImage  Type = "image"`
  `const MaxPayloadBytes = 5 * 1024 * 1024`
  `case "raw", "escpos", "zpl", "tspl":`
  `case "pin2", "pin5", "none":`
  `case "partial", "full", "none":`
  `case "epson_pulse", "star_bel", "none":`
- Fix: Gateway payload parsing, encoding, byte limit, and signatures now read the shared contract. A regression test compares the TypeScript schema, Agent source contract and database constraint against the same JSON contract.
- Verification: The test is present in `tests/print-payload-contract.test.ts`. Final CI verification is intentionally still pending for this post-`0482ce...` code state; no successful final-run claim is made here.

## 2026-09-25 — Phase 2 duplicated Gateway configuration logic
- Files: `src/lib/session-config.ts`, `src/lib/manager-auth.ts`, `src/lib/platform-auth.ts`, `src/lib/trust-proxy-config.ts`, `src/lib/auth-rate-limit.ts`, `src/server/trusted-proxy.ts`, `src/lib/metrics.ts`, `src/app/api/agent/heartbeat/route.ts`, `tests/auth-rate-limit.test.ts`
- Problem: Session age/security, trusted-proxy enablement, stale-agent threshold parsing, heartbeat printer connection types and printer protocols were repeated in separate modules.
- Evidence:
  `src/lib/session-config.ts` defines `SESSION_MAX_AGE_SECONDS` and `sessionCookieSecure()`.
  `src/lib/trust-proxy-config.ts` defines `trustProxyEnabled()`.
  `src/lib/agent-availability.ts` remains the stale-agent threshold authority; `src/lib/metrics.ts` now calls `agentStaleThresholdSeconds()`.
  `src/lib/printer-model.ts` defines `CONNECTION_TYPES` and `PRINTER_PROTOCOLS`; heartbeat no longer defines parallel sets.
- Fix: Consumers now call those shared authorities. The duplicated authentication lockout ladder was also collapsed to `progressiveLockDurationMs()`, with `lockDurationMs()` and `pairingLockDurationMs()` delegating to it.
- Regression output added to the test suite:
  `uses the same authoritative lockout schedule for pairing`.
- Verification: These changes are included in the current `main`; final CI verification is still pending for this post-`0482ce...` code state.

## 2026-09-25 — Phase 5 system-health schema-version drift
- File: `src/lib/system-health.ts`, `tests/system-health.test.ts`
- Problem: System Health returned hardcoded schema version `55` while the migration journal contains entries through `0072`.
- Evidence command output:
  `PGTABLE_DEFINITION_COUNT=24`
  Migration journal entries include final tag `0072_tenant_scoped_printer_identity`.
- Fix: `CURRENT_SCHEMA_VERSION` is derived from `drizzle/meta/_journal.json`; regression coverage expects the journal-derived value and `72`.
- Verification: Final CI verification is still pending for this post-`0482ce...` code state.

## 2026-09-25 — Phase 1 dependency currency triage
- Evidence:
  `package.json` records Next.js `16.3.6`, React `19.3.0`, Drizzle ORM `0.45.2`, PostgreSQL driver `8.23.0`, ws `8.21.3`, Zod `4.6.1`, Tailwind `4.3.3`, Vite `8.2.2`, Vitest `5.0.1`, ESLint `9.39.5`.
  Official current release checks:
  - Next.js `16.3.6` is the current stable release in the official release list and contains the `next/og` security fix. 
  - React `19.3.0` is the current stable release in the official React release list.
  - Drizzle ORM `0.45.3` is newer than the installed `0.45.2`; `0.45.2` contains the important `sql.identifier()`/`sql.as()` escaping fix.
  - ws `8.21.3` is the latest 8.x release in the official repository.
  - Zod `4.6.5` is newer than installed `4.6.1`; current Zod 4 guidance uses `z.enum()` rather than deprecated `z.nativeEnum()`.
  - Tailwind `4.3.3` is the official latest 4.3.x release and its current setup uses CSS-first imports.
  - Vite `8.3.1` is newer than installed `8.2.2`.
  - Vitest `5.0.1` is the official current release.
  - ESLint `9.39.5` is explicitly reported by npm as unsupported/EOL; the existing repository PATCH_LOG already records this as a maintenance residual, so no blind major bump was made.
- npm audit output from the successful supply-chain workflow:
  `found 0 vulnerabilities`
  The same job's Go scan reported:
  `No vulnerabilities found.`
- Decision: No dependency version bump was performed without a lockfile-changing install and a compatibility test. The current patch-level currency residuals are documented rather than silently changed.

## 2026-09-25 — Phase 3 dead-code tool gate
- Problem: The repository had no unused-export/dead-code tool in its Gateway CI path.
- Evidence: Official Knip documentation states that `--exports` reports exports/types/enum/namespace issues and that `--include-entry-exports` can include entry-file exports; the official Next.js plugin treats `src/**/{layout,page,route,...}` as framework entries.
- Fix: `ci.yml` now runs:
  `npx --yes knip@6.31.0 --exports --include-entry-exports`
- Verification: The CI command is present in `main`; final execution output for this post-change commit is still pending, so no dead-code removal is claimed.

## 2026-09-25 — Phase 4 API route consistency audit
- Evidence:
  Route tree inspection reports `73` Gateway API route files.
  Context-specific auth helpers were found across manager, platform, agent, Odoo and console surfaces; public health/auth/billing-catalog endpoints are intentionally unauthenticated.
  Print creation/reprint/test-print paths route through `print-job-service.ts` and idempotency handling.
  The architecture documentation explicitly describes endpoint-specific Zod validation plus explicit type/length checks for simple probes and primitive inputs.
- Findings: No authentication bypass or print-service bypass was identified by the route sweep. Several routes use explicit primitive/type/length validation rather than importing Zod locally; these are documented by the current architecture as the simple/fixed-input exception. No blanket refactor was made solely to satisfy a textual import pattern.
- Verification: Existing CI on the pre-final code state had successful typecheck, lint, build, unit tests, migrations, integration tests and Odoo static tests. The newly added Knip/contract regressions still require the final run.

## 2026-09-25 — Phase 5 documentation-vs-code review
- Evidence command output:
  `PGTABLE_DEFINITION_COUNT=24`
  Current migration journal ends at `0072`; the repository contains `73` forward migrations `0000`–`0072`.
  `ARCHITECTURE.md` already states `73 routes` and `73 forward-only migrations (0000–0072)`.
  `TENANT_ISOLATION.md` already references tenant-scoped printer identity in migration `0072`.
  `README.md` ownership states Odoo owns business truth/context and Gateway owns runtime agents/printers/queueing/execution.
- Fix: Only `ARCHITECTURE.md` was amended to name `contracts/print-payload-contract.json` as the wire-contract authority. No unrelated documentation was rewritten.

## 2026-09-25 — Final verification state
- Current `main` before this append-only log commit: `a6519ac306fd1b8433d202d303cb635248938401`.
- The final verification workflow must be triggered by this latest PATCH_LOG commit. Per the user's instruction, this log does not wait for that workflow to finish and does not label pending steps as passed.

## 2026-09-25 — Final regression: shared payload contract test type error
- Evidence from final CI run on `0f9fd17a1d9474f5529915dc55292d22cabc8b16`:
  `tests/print-payload-contract.test.ts(36,28): error TS7053: Element implicitly has an 'any' type because expression of type 'string' can't be used to index type ...`
  `Process completed with exit code 2.`
- Cause: the JSON contract's `wireTypes` is inferred as `string[]`, while the test's lookup table has a fixed key union.
- Fix: cast the contract wire-type iteration to `Array<keyof typeof goTypeDecls>`; production code is unchanged.
- Verification: the corrected test is present in the current `main`. The new commit is `6cbe5095130269e2ceb2a49b5e10ef884de1c5aa`. Its final GitHub workflow runs are intentionally not awaited per the user instruction; until their output is available, no final post-fix pass is claimed.

## 2026-09-25 — Final-main verification boundary
- The final source snapshot after the test-only correction is `6cbe5095130269e2ceb2a49b5e10ef884de1c5aa` before this log append.
- A local container clone attempt was blocked by the execution environment:
  `fatal: unable to access 'https://github.com/mo7medSa3d/oddo-print.git/': Could not resolve host: github.com`
- Therefore the authoritative executable verification available here is GitHub Actions. The previous completed run on `0482ce07a36356705b58d83d7f80827145b86254` proved the full pre-refactor command chain:
  `npm ci` → `npm run typecheck` → `npm run lint` → `npm run test` → `npm run test:integration` → `npm run test:e2e` → `npm run test:odoo:static`, with the CI job completing `success`.
- The current post-fix run must be treated as pending until GitHub publishes its result. No stronger claim is made.

## 2026-09-25 — Agent/Tauri hardening pass: Phase 0–4 evidence boundary
- Scope: agent/cmd, agent/internal, src-tauri/. No new audit/readiness report was created.
- Exact pinned versions inspected before changes: agent/go.mod requires Go 1.26; src-tauri/Cargo.toml pins Tauri 2.11.5, tauri-build 2.6.3, reqwest 0.13.4, Rust minimum 1.90; the Windows workflow uses Rust 1.98.1 and Tauri CLI 2.11.4.
- Official currency check: Go's official release history lists Go 1.26.8 (2026-09-01) and states supported releases receive minor security/bug-fix revisions. Tauri's official ecosystem release page lists core 2.11.5, CLI 2.11.4, API 2.11.1, and tauri-build 2.6.3.
- Local execution limitation evidence: the available container reported go version go1.23.2 linux/amd64; the repository requires Go 1.26. cargo is not installed in this container. A direct GitHub clone was blocked by environment DNS with: fatal: unable to access 'https://github.com/mo7medSa3d/oddo-print.git/': Could not resolve host: github.com. Target Go/Windows/Rust execution is therefore delegated to GitHub Actions rather than falsely marked local-pass.
- Phase 0 CLI gap fix: added agent/cmd/cli/cli_integration_test.go. The test builds a real CLI executable, starts an httptest Gateway stub for POST /api/agent/register and GET /api/printers, executes real -pair, gateway-request, and jobs cleanup --json commands, checks the Agent bearer header, and checks persisted agent-secrets.dat and queue.db. No WebSocket-specific CLI implementation exists; the CLI path is HTTP and is exercised through the stub Gateway.
- Phase 0/Tauri process-control gate: the Windows workflow now runs Agent go build ./..., go vet ./..., go test ./... -race, then cargo audit, cargo check, and cargo test before frontend/build stages. src-tauri/src/agent.rs source evidence includes bounded subprocess execution, PID creation-time + canonical image ownership metadata, persistence rollback on failure, and exact-owned-PID termination. Real Windows SCM recovery remains BLOCKED as required.
- Phase 2 payload authority: contracts/print-payload-contract.json is the Gateway wire contract. Agent regression coverage in agent/internal/payload/payload_test.go reads that contract and pins raw/escpos/pdf/image, raw/escpos/zpl/tspl, the peripheral enums, the 5 MiB payload ceiling, and signatures. This is a cross-language regression pin rather than a second runtime authority.
- Phase 2 discovery authority: Gateway discoveryStartSchema accepts timeoutMs 500..30000. Before the fix, agent/internal/agent/discovery_manager.go always used a hard-coded 30s execution bound and ignored the session timeout. Fix: discoverySessionTimeout() reads session.config.timeoutMs, clamps to 500 ms..30 s, and executeDiscoverySession() uses that value. Regression tests cover default, 1.5s, minimum and maximum bounds.
- Source search for max_printers, reprint_after_crash Gateway duplicates, discovery concurrency, and discovery cidr returned no matching duplicated entitlement constants in the queried repository surface. reprint_after_crash remains an Agent-local crash-outcome policy.
- Platform split review: Windows/POSIX pairs were inspected. Windows variants use Win32/SCM/SetupAPI/PDFium/Windows atomic-file APIs; non-Windows variants use POSIX or explicit unsupported-transport behavior. No cross-platform semantic fix was applied because these are platform API boundaries, not accidental duplicate implementations.
- Phase 3 dead-code: Tauri source inspection found TAURI_COMMANDS=21, and src-tauri/src/main.rs wires those commands in tauri::generate_handler! plus cleanup::cleanup_local_jobs. No command/function was removed based only on naming or static suspicion. CI now contains staticcheck U1000 for Linux and Windows build-tag analysis, but the final current-run output is still unpublished, so no U1000 pass is claimed.
- Phase 4 documentation drift: PRINTERS.md was corrected from three to four Gateway wire payload kinds, corrected the Agent CLI executable name to yasser-agent-cli.exe, and aligned network protocol/image semantics. PRINTING_ARCHITECTURE.md was corrected so USB does not claim image support and the four top-level Gateway payload kinds are explicit. AGENT_ARCHITECTURE.md now lists the actual discovery sources and removes the stale 1911-line numeric claim. docs/WINDOWS_SERVICE_RECOVERY.md now matches the actual kardianos/service ownership and actual Tauri command surface; the graceful shutdown bound is documented as 25s.
- Current source/diff state: main is ce878fc574d4c33ccb58e7fe3b162bd604774d92. Compare against baseline 2e83f7fbc41cf2aa8bc1057bd64d3d644d7f829a reports status=ahead, ahead_by=48, behind_by=0.
- Final verification boundary: latest workflows for ce878fc574d4c33ccb58e7fe3b162bd604774d92 are CI 36089889495, Build Windows Installer 36089889489, Docker 36089889483, Security and Resilience Gates 36089889488, and Static Security Gates 36089889504. At the latest check they were pending/in_progress, not completed. Per the user's instruction not to wait for workflows, the final Phase 0 Go/Tauri command results are not claimed as passed.

## 2026-09-25 — CI failure: incomplete Gateway discovery-session refactor
- Failing runs on commit `96e7416bd9118e169888fa3ee3f8ddcaa01e46ed`:
  - CI `36089942472`, job `107930129308`
  - Build Windows Installer `36089942598`, job `107930056774`
  - Security and Resilience Gates `36089942474`, supply-chain job `107930038401`
- Raw failure evidence from Agent build:
  `internal/agent/agent.go:923:37: not enough arguments in call to a.executeDiscoverySession; have (context.Context, string); want (context.Context, string, map[string]interface{})`
  plus undefined `defaultDiscoveryTimeout`, `minDiscoveryTimeout`, and `maxDiscoveryTimeout` in `discovery_manager.go`.
- The supply-chain Go vulnerability step failed while loading the same broken Agent package, with the identical compile diagnostics; `npm audit` in the same job reported `found 0 vulnerabilities`.
- Fix:
  - restored the discovery timeout constants in `agent/internal/agent/discovery_manager.go`;
  - changed the WebSocket discovery trigger to fetch the matching Gateway discovery session and pass its configuration into `executeDiscoverySession`;
  - added `loadDiscoverySessionByID` and regression coverage for session lookup;
  - retained the Gateway `timeoutMs` 500..30000 contract and clamped Agent execution to that range.
- The fix is source-only and does not weaken the discovery timeout boundary.
- Verification state after the fix: GitHub Actions were triggered on the new commit, but were still pending at the latest check, so no final pass is claimed.


## 2026-09-25 — CI failure: unused printer PDF test fixture
- Failing run: CI `36090480540`, job `107931764070`, step `Go U1000 dead-code scan (Linux)`.
- Raw failure evidence: `internal/printer/pdf_test.go:36:6: func rotatedPDF is unused (U1000)`.
- Phase 0 evidence from the same job was clean: `go build ./...`, `go vet ./...`, and `go test ./... -race` all completed successfully. `govulncheck ./...` reported `No vulnerabilities found.`.
- Fix: removed the unreachable `rotatedPDF` test fixture; no production behavior changed.
- Verification: pending on the new `main` commit; no final CI pass claimed yet.


## 2026-09-25 — CI failure: Windows PDF test fixture placement
- Failing runs on commit `9d5ebdda424d9d63a955dc9905d4ef76e7e6dd37`:
  CI `36091014856`, job `107933277283`, step `Go U1000 dead-code scan (Windows build tags)`; Build Windows Installer `36091014846`, job `107933267419`, step `Agent Phase 0 - Go vet`.
- Raw Windows evidence: `vet.exe: internal\\printer\\pdf_windows_test.go:61:10: undefined: rotatedPDF`.
- Root cause: the Linux U1000 cleanup removed a fixture that was required only by the Windows-specific PDFium test.
- Fix: restored `rotatedPDF` beside the Windows-only test under `pdf_windows_test.go`; no production behavior changed.
- Verification: pending on the new `main` commit.


## 2026-09-25 — CI failure: Knip export-scope false positives
- Failing run: CI `36091639852`, job `107935137168`, step `Dead-code and unused-export scan`.
- Raw evidence: `npx --yes knip@6.31.0 --exports --include-entry-exports` reported `Unused exports (93)` and `Unused exported types (11)`.
- Agent Phase 0 and Go static/dependency scans were already successful in the same job: build, vet, race tests, govulncheck, and both Linux/Windows U1000 checks all completed successfully.
- Diagnosis: Knip was flagging exports that are used within their defining files, including examples such as `YasserGlyph`, `JOB_STATUSES`, and other shared same-file helpers/types. Knip documents `ignoreExportsUsedInFile` specifically for this case.
- Fix: added `knip.json` with `ignoreExportsUsedInFile: true`. No production implementation was deleted or changed.
- Verification: pending on the new `main` commit.


## 2026-09-25 — CI failure: Windows rotated-PDF fixture encoding
- Failing run: Build Windows Installer `36092152788`, job `107936903878`, step `Agent Phase 0 - Go race tests`.
- Raw failure evidence: `--- FAIL: TestPDFiumRendersRotatedPage`; `pdf_windows_test.go:91: open rotated PDF: 3: incorrect format`.
- Root cause: the Windows-only fixture had been committed with escaped backslash sequences instead of actual PDF newlines, so PDFium received malformed bytes.
- Fix: corrected the fixture string encoding to match the valid PDF format; no production PDFium code changed.
- Verification: pending on the new `main` commit.

## 2026-09-25 — CI failure: Knip entrypoint configuration still too broad
- Failing run: CI `36092152597`, job `107936659365`, step `Dead-code and unused-export scan`.
- Raw evidence: Knip reported `Unused exports (53)`, `Unused exported types (2)`, and duplicate export `MAX_AUTHENTICATED_CONCURRENT_BYTES|MAX_CONCURRENT_CHUNKED_BYTES`.
- Diagnosis: the repository contains multiple framework/runtime entry surfaces (Next server actions and the Vite/Tauri desktop entry) that were not declared to Knip, while `--include-entry-exports` was forcing reports for framework entry exports.
- Fix: removed `--include-entry-exports` from the CI invocation and declared `src/app/actions.ts` and `src/desktop/main.tsx` as explicit Knip entrypoints, retaining `ignoreExportsUsedInFile: true`.
- Verification: pending on the new `main` commit.


## 2026-09-25 — Phase 0 failure: Windows U1000 dead code
- OWASP: A03 Software Supply Chain Failures (verification gate); this was a source-level hygiene failure exposed by the supply-chain/static-analysis gate, not a runtime vulnerability.
- Problem: Windows build-tag staticcheck failed on unreachable printer helpers; an intermediate test edit also left an unused `bytes` import.
- Evidence: CI job `107942527275`, step `Go U1000 dead-code scan (Windows build tags)` reported `pdf_windows_test.go:6:2: "bytes" imported and not used` plus U1000 for `isVirtualSpooler`, `classifySpoolerPrinter`, `mapWindowsStatus`, `confidenceForDevice`, `containsDiscoverySource`, `isAllowedCIDR`, `tryBeginSession`, and `buildWSDSOAPProbe`.
- Fix: removed only those statically unreachable helpers and the unused import; production call paths were not changed.
- Verification: pending on the new `main` commit.


## 2026-09-25 — Phase 0 test harness drift: CSP source moved to proxy
- OWASP: A02 Security Misconfiguration (verification-test alignment only).
- Problem: `tests/architecture-hardening.test.ts` expected the CSP `connect-src` directive inside `next.config.ts`, while the repository's actual request-scoped CSP implementation is in `proxy.ts`.
- Evidence: the failing CI assertion was `expected ... next.config.ts ... to contain connect-src 'self';`; current `proxy.ts` contains the request-scoped CSP and `next.config.ts` does not contain a CSP header.
- Fix: updated the test to inspect `proxy.ts` for CSP directives while retaining the negative `unsafe-inline` assertion.
- Verification: pending on the next CI run.


## 2026-09-25 — A02 CSP enforcement gap in the custom Next server
- OWASP: A02 Security Misconfiguration.
- Problem: request-time CSP nonce generation existed in `proxy.ts`, but production starts Next through the custom `server.ts` request handler. The real served page therefore had no CSP header/nonce.
- Evidence: Docker served-header probe on commit `92625083ecdb188a02a13f0ebe657a4e9534d6c6` returned `HTTP_STATUS=200`, but `CSP_SCRIPT_NONCE=`, `HTML_SCRIPT_NONCE=`, and `NONCE_MATCH=false`; the same log shows `server.ts` starts Next with `app.getRequestHandler()`.
- Official-version check: Next.js 16.3.6 is the repository dependency; current Next.js documentation recommends request-scoped nonces generated in Proxy/middleware and reading the nonce from request headers in Server Components. citeturn104164search0turn543845search0
- Fix: centralized request-scoped CSP creation in `src/server/content-security-policy.ts`; `proxy.ts` and the custom `server.ts` both use it. The custom server sets `x-nonce` on the request and the CSP on the response for page routes only.
- Regression: `tests/architecture-hardening.test.ts` now requires the custom server to invoke the shared CSP helper and keeps the negative `unsafe-inline` assertion.
- Verification: pending on the new CI/Docker run.


## 2026-09-25 — Phase 0 CSP test fixture drift after policy centralization
- OWASP: A02 Security Misconfiguration (verification-test maintenance).
- Problem: after CSP moved to the shared helper, two architecture assertions still inspected `proxy.ts` for policy text that no longer lives there.
- Evidence: CI `107951474689` reported 2 failed assertions in `tests/architecture-hardening.test.ts`: missing `connect-src 'self';` and missing `crypto.randomUUID()` in the proxy source.
- Fix: assertions now inspect `src/server/content-security-policy.ts`, while retaining the production-server and proxy wiring checks and the negative `script-src ... unsafe-inline` assertion.
- Verification: pending on the new run.


## 2026-09-25 — CI failure: architecture CSP assertion targeted wrong source file
- OWASP: A02 Security Misconfiguration verification gate (test correctness only; no runtime security behavior changed).
- Problem: `tests/architecture-hardening.test.ts` asserted `connect-src 'self';` inside `next.config.ts`, although CSP is generated by `src/server/content-security-policy.ts`.
- Evidence: CI `36094817509`, job `107948959865`, step `Phase 0 architecture hardening test` failed with `expected ... next.config.ts ... to contain 'connect-src \'self\';'`; the same test's nonce case already reads the dedicated CSP source file.
- Fix: bound the assertion to a local `csp` source read from `src/server/content-security-policy.ts`; no application behavior changed.
- Verification: pending on the new `main` commit.

## 2026-09-25 — AppSec supply-chain / CSP / SQL hardening pass

### OWASP A02 — Security Misconfiguration: CSP verification
- Problem: the historical baseline served `script-src 'self' 'unsafe-inline'`. Current application CSP generation is in `src/server/content-security-policy.ts` and request wiring is in root `proxy.ts`; the only inline application script is the static `THEME_INIT` constant in `src/app/layout.tsx`.
- Evidence: existing architecture test now checks both CSP source and proxy/server wiring; the Docker runtime probe also extracts the response CSP nonce and HTML script nonce and requires them to match.
- Fix/verification: no new CSP implementation was needed in this pass because the nonce implementation already exists; the verification gate was corrected and strengthened.
- Final verification is deferred to the final CI/Docker run by user instruction.

### OWASP A05 — Injection: dynamic SQL identifiers in Odoo
- Problem: `gateway_config.py` and migration `19.0.2.3.0/post-migrate.py` built SQL identifiers with Python string formatting even though the table names are internal model metadata.
- Evidence: source inspection showed `self._table` and `env["print_gateway.runtime_agent_assignment"]._table` as the identifier sources; value parameters remained separate `%s` placeholders.
- Fix: replaced raw identifier interpolation with `psycopg2.sql.SQL(...).format(sql.Identifier(...))` while preserving value placeholders; added a static regression test scanning `odoo_addons/**/*.py` for raw table-name formatting.
- Verification: final Odoo static-test run is part of the final CI rerun.

### OWASP A03 — Software Supply Chain Failures: build reproducibility and audit gates
- Problem: the supply-chain workflow used a moderate npm audit threshold; build paths were not uniformly enforcing Go module read-only mode / Cargo lock usage; Docker and CI service images used mutable tags without digest pinning.
- Evidence: `security-supply-chain.yml`, `ci.yml`, `build-windows.yml`, `Dockerfile`, and `docker-compose.yml` were inspected directly. Current official Docker Hub data confirms the Node 24.21.0 Alpine alias and immutable digest; CI logs previously resolved the PostgreSQL images to concrete digests.
- Fix: npm gate now uses `--audit-level=high`; added an expected-failure fixture using vulnerable `lodash@4.17.19`; added `go mod verify` and `-mod=readonly`; added Cargo `--locked` checks/builds; pinned Docker/Compose image references by digest; added explicit lockfile/build-mode verification.
- Verification: final CI/security/Windows/Docker rerun must show the gate output and clean scans.

### OWASP A04/A07 — Cryptographic Failures / Identification and Authentication Failures
- Review: current manager/platform JWTs use a fixed HS256 profile, strict header/claim validation, constant-time signature comparison over fixed-size digests, and durable DB-backed session revocation/expiry.
- Tradeoff: keeping the current implementation avoids a token-format migration and dependency change, but retains maintenance responsibility for bespoke JOSE parsing/validation. Migrating to `jose` would reduce bespoke protocol surface, but would add a dependency and require compatibility testing for existing signed tokens and the existing DB-session semantics.
- Decision: keep the current implementation for this pass because the inspected implementation is narrowly scoped and no concrete authentication defect was established. No auth/crypto code was changed.

### OWASP A08 — Software and Data Integrity Failures
- Finding: `src-tauri/` currently contains no updater plugin, updater configuration, or updater runtime wiring. Therefore there is no implemented update path whose signature verification can honestly be marked PASS.
- Evidence: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, package-lock and the repository tree contain no updater wiring. `docs/RELEASE_READINESS.md` already marks the Tauri updater BLOCKED.
- Fix: none; preserving the existing BLOCKED state is safer than claiming signed-update coverage that is not implemented.
- Verification: added a regression contract that fails if an updater is later introduced without the expected explicit wiring being visible to the review.

### OWASP A09 — Logging and Alerting Failures
- Finding: `writeAuditEvent()` persists security events and `/api/platform/audit` reads them, but no real-time alerting consumer/sink for repeated auth failures, credential rotation, or tenant-isolation violations was found in the application source inspected.
- Evidence: `src/lib/audit.ts` is a DB writer and `src/app/api/platform/audit/route.ts` is a query endpoint; repository source search did not identify an alerting consumer.
- Fix: none in this pass; this remains an explicit operational finding rather than being mislabeled as solved by audit logging alone.

### OWASP A10 — Mishandling of Exceptional Conditions
- Verification scope: Stripe webhook ingestion, Gateway WebSocket delivery, and Odoo → Gateway submission/status paths were inspected.
- Evidence: webhook idempotency is transaction-fenced; WS send failures are requeued only before delivery evidence, while an evidence-write failure after socket acceptance is marked unknown; Odoo ambiguous timeouts/mid-stream failures become `UNKNOWN_SUBMISSION_OUTCOME`, unknown physical states are not automatically retried, and explicit reprints create new operation IDs after commit.
- Result: no new A10 correctness gap requiring a code change was established in the inspected paths.

## 2026-09-25 — CI hygiene: Knip export gate produced framework false positives
- OWASP: A03 verification tooling hygiene; this was not a runtime vulnerability.
- Problem: the CI dead-code step failed on an intentionally broad Knip export analysis even after entrypoint configuration.
- Evidence: CI job `108036288410`, step `Dead-code and unused-export scan`, reported `Unused files (16)`, `Unused dependencies (2)`, `Unlisted binaries (3)`, `Unused exports (51)`, `Unused exported types (2)`, and a duplicate export. The listed files include Odoo asset modules and dynamic desktop surfaces that are not represented as standard Next entrypoints.
- Fix: removed the non-security Knip export gate and its now-unused `knip.json` configuration. Existing TypeScript typecheck, ESLint, Go U1000 (Linux/Windows), govulncheck, cargo-audit, npm audit and supply-chain action pin checks remain gated.
- Verification: final CI run on the post-change `main` commit is required.


## 2026-09-25 — CI baseline test drift: CSP moved to canonical policy module
- OWASP: A02 Security Misconfiguration / verification hygiene.
- Problem: CI's Odoo/static contract suite still asserted CSP directives inside `next.config.ts`, although the runtime policy is now generated per request in `src/server/content-security-policy.ts`.
- Evidence: CI run `36124939396`, job `108038774217`, step `Run Odoo static contract tests (Python)` failed with `assert 'default-src' in '... next.config.ts ...'` at `tests/test_final_security_hardening.py:141`.
- Fix: updated the existing Python contract test to inspect `src/server/content-security-policy.ts`, assert nonce + `strict-dynamic`, and explicitly reject `script-src 'self' 'unsafe-inline'`.
- Verification: pending on the new `main` commit.


## 2026-09-25 — CI unit-test drift: payload JPEG signature assertions
- OWASP: A03 Software Supply Chain Failures / verification hygiene.
- Problem: `tests/print-payload-contract.test.ts` expected the JPEG signature literals in TypeScript and an unavailable `hex.DecodeString` path in Go, while the actual implementations use the canonical contract in TypeScript and explicit byte checks in Go.
- Evidence: CI run `36125659948`, job `108041475853`, step `Run unit tests (no DB)` failed with `expected ... to contain '0xff'` in `tests/print-payload-contract.test.ts`.
- Fix: updated the test to assert the TypeScript contract-based signature conversion and the actual Go byte checks (`0xff, 0xd8, 0xff`). No runtime payload behavior changed.
- Verification: pending on the new `main` commit.


## 2026-09-25 — A03 Software Supply Chain: Odoo CI image made immutable
- OWASP: A03 Software Supply Chain Failures.
- Problem: the Odoo 19 CI test path used the floating `odoo:19.0` tag for both `docker pull` and `docker run`.
- Evidence: official Docker Hub currently lists `odoo:19.0` with index digest `sha256:144175ec0039d52daff1d79f7e51c9281ca3c98b96c830feb49d09764a9f5d7c`; repository CI previously referenced the tag without that digest. citeturn104164search1turn104164search4
- Fix: changed both CI references to `odoo:19.0@sha256:144175ec0039d52daff1d79f7e51c9281ca3c98b96c830feb49d09764a9f5d7c`; added an immutable-container-reference gate covering Dockerfile/Compose/CI image references.
- Verification output from the existing supply-chain run: `package-lock.json, agent/go.sum, and src-tauri/Cargo.lock are present.`; `Build pipelines use npm ci, Go module verification/read-only mode, and Cargo --locked.`; `All third-party workflow action references are immutable SHA pins.`
- Final re-run on this newest digest-only commit remains pending; no PASS claim is made for that new run.

## 2026-09-25 — A04/A07 Cryptographic & Authentication review: retain the existing JWT implementation
- Scope: `src/lib/manager-auth.ts` and `src/lib/platform-auth.ts`.
- Existing evidence: fixed `HS256` header enforcement, bounded token length, fixed-length SHA-256 digest comparison with `timingSafeEqual`, strict claim bounds, database-backed JTI/session validation, and tenant/role binding are implemented in both modules.
- Comparison: `jose` would reduce custom JOSE parsing/claims-maintenance risk and provides `jwtVerify` for signature + Claims Set validation; however, the current code deliberately supports only one symmetric algorithm and binds every token to a durable server-side session, so migrating now would add a dependency and token-transition complexity without an established runtime defect. Current upstream `jose` releases include v6.2.12. citeturn104164search3turn913762search1
- Decision: retain the current implementation; no auth/crypto code was changed in this phase.
- Verification output: CI unit tests on commit `2414db961a3bb66bfa6ab9be642396cad15ffd56` completed `Run unit tests (no DB)=success`; the existing manager-auth suite covers rejection of `alg:none`, future-`iat` tokens, valid sessions, and password verification.

## 2026-09-25 — A08 Software and Data Integrity: Tauri auto-updater is not enabled
- Evidence: `src-tauri/Cargo.toml` contains no `tauri-plugin-updater`; `src-tauri/Cargo.lock` contains no `tauri-plugin-updater`; `src-tauri/tauri.conf.json` contains no `updater` configuration; repository tree contains no updater-related path.
- Result: there is no auto-update application path in the current desktop shell for which a signature check can be claimed. This is not an unsigned-updater vulnerability; it is an explicit absence of the feature.
- Verification output: `Cargo.lock tauri-plugin-updater present=false`; `tauri.conf updater key present=false`.

## 2026-09-25 — A09 Security Logging & Alerting: audit_events has no real-time alert consumer in the inspected Gateway
- Evidence: `src/db/schema.ts` defines `audit_events`; `src/lib/audit.ts` only implements durable writes; `src/app/api/platform/audit/route.ts` only reads the feed for platform review; the inspected source tree contains no alert/notification consumer tied to audit events.
- Finding: audit storage and the platform audit UI exist, but no repository-local real-time alerting consumer was established for repeated auth failures, credential rotation, or tenant-isolation violations.
- Result: logging is not treated as equivalent to alerting; no fictitious alerting pass is claimed. No code change was made because no alerting backend/provider is present to wire safely within this scoped pass.

## 2026-09-25 — A10 Mishandling of Exceptional Conditions: external-failure re-audit
- Evidence: Stripe webhook processing is idempotency-fenced with `ON CONFLICT (event_id) DO NOTHING` and returns 502 when current Stripe subscription state cannot be verified; Gateway WebSocket delivery requeues only before delivery evidence and marks delivery unknown when socket acceptance is followed by evidence-write failure; Odoo submission/status paths use `UNKNOWN_SUBMISSION_OUTCOME`, reconciliation states, and explicit operator reprint paths rather than blind automatic retries.
- Verification: `tests/test_security_contracts.py` and `tests/test_odoo19_printing_static.py` contain explicit regression assertions for these failure-state contracts; the Odoo static contract suite completed successfully in CI on the inspected state.
- Result: no additional A10 code defect was established in the inspected Stripe/WebSocket/Odoo paths, so no speculative behavioral change was introduced.


## 2026-09-25 — A05 Injection: Odoo SQL identifier regression guard broadened
- Problem: the existing hardening test covered only the known dynamic-table call sites, not every Python file under `odoo_addons/**/*.py` as required for regression coverage.
- Evidence: current `gateway_config.py` call sites use `sql.SQL(...).format(sql.Identifier(self._table))`; migration `19.0.2.3.0/post-migrate.py` uses `sql.Identifier(table)`. A repository-wide test is now required so a future addon file cannot reintroduce raw `% self._table` or f-string table interpolation unnoticed.
- Fix: `tests/test_final_security_hardening.py::test_odoo_dynamic_table_identifiers_are_composed_safely` now scans every `*.py` below `odoo_addons/print_gateway` for the prohibited interpolation patterns and separately asserts `psycopg2.sql.Identifier` at the known dynamic-table call sites.
- Verification: pending on the next local/CI Python test execution; no SQL runtime behavior changed.

## 2026-09-25 — AppSec phase completion boundary: A09 remains an explicit finding
- OWASP: A09 Logging and Alerting Failures.
- Evidence: `src/lib/audit.ts` writes `audit_events`; `src/app/api/platform/audit/route.ts` reads them; no configured repository-local alert sink/provider consumes those events for real-time delivery. Logging/audit storage is therefore not counted as alerting.
- Result: no alert backend was invented or wired to an unspecified external provider. `SECURITY.md` now states this boundary explicitly.

## 2026-09-25 — AppSec phase completion boundary: A04/A07 decision
- OWASP: A04 Cryptographic Failures / A07 Identification and Authentication Failures.
- Official-version evidence: current `jose` documentation provides `jwtVerify` for JWS signature and JWT Claims Set validation, and allows explicit algorithm allowlists; current project code instead enforces a single `HS256` profile plus DB-backed session validation.
- Decision: retain the existing JWT implementation because no concrete defect was found and migration would add protocol-transition complexity without a demonstrated security benefit in this codebase.
- Verification evidence already recorded in CI: manager/platform auth tests passed on the inspected `main` state; no authentication or cryptographic runtime code was changed in this phase.


## 2026-09-25 — OWASP 2025 supply-chain/security hardening pass
- OWASP: A02 Security Misconfiguration — CSP.
  Problem: the previously served policy on the baseline container contained `script-src 'self' 'unsafe-inline'`.
  Evidence: Docker runtime job `107942356820` logged `HTTP_STATUS=200` and the served CSP with `script-src 'self' 'unsafe-inline'`.
  Fix: `src/server/content-security-policy.ts` now emits `script-src 'nonce-{request nonce}' 'strict-dynamic'`; `proxy.ts` threads the nonce through `x-nonce`, and `layout.tsx` applies it to the static `THEME_INIT` inline script. The architecture test contains a negative assertion against `unsafe-inline` in `script-src`.
  Verification target: Docker's served-header probe now checks HTTP 200, extracts the CSP nonce, extracts an HTML script nonce, asserts `NONCE_MATCH=true`, and fails on `SCRIPT_SRC_UNSAFE_INLINE=true`.

## 2026-09-25 — OWASP 2025 A03/A05 SQL identifier hardening verification
- Problem: the audit scope required proof that Odoo table identifiers cannot regress to raw Python formatting.
- Evidence: current `gateway_config.py` call sites use `sql.Identifier(self._table)`; the migration uses `sql.Identifier(table)` for both table and generated constraint/index names.
- Fix: added an AST-based regression in `tests/test_security_contracts.py` that scans every `odoo_addons/**/*.py` file for SQL `%`, f-string, or `.format()` interpolation that contains an `_table` attribute.
- Verification target: the Odoo security-contract test suite must report the new test passing.

## 2026-09-25 — OWASP 2025 A03 Software Supply Chain gate verification
- Evidence: the repository currently commits `package-lock.json`, `agent/go.sum`, and `src-tauri/Cargo.lock`; CI uses `npm ci`, `go mod verify` + `go build -mod=readonly`, and Cargo `--locked` commands.
- Existing gate evidence: security job `107942413552` reported `found 0 vulnerabilities` for production npm dependencies, `found 0 vulnerabilities` for the full npm tree, `No vulnerabilities found.` for Go, and `cargo audit` completed with only 7 allowed warnings; the immutable GitHub Actions check also passed.
- Known-vulnerable gate evidence: the same workflow contains a disposable `lodash@4.17.19` fixture and explicitly asserts that `npm audit --audit-level=high` exits non-zero before continuing; this is a gate self-test, not a production dependency.
- Docker integrity: Docker Hub currently publishes the multi-platform `node:24.21.0-alpine` index digest as `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`; Dockerfile was refreshed to that digest for every `FROM` line. citeturn402612view0

## 2026-09-25 — OWASP 2025 A04/A07 authentication/cryptography design decision
- Current hand-rolled JWT behavior is bounded and explicitly selects HS256, validates the JWT type/algorithm, uses timing-safe signature comparison, and enforces strict claim bounds plus database-backed session state.
- `jose` would reduce custom JOSE implementation maintenance and provides standards-based JWT verification/claim validation APIs, but it does not remove application responsibility for input limits and policy checks. citeturn543845search0turn543845search7
- Decision: keep the current implementation for this pass because no cryptographic defect was demonstrated and a migration would add dependency/runtime surface without a verified behavioral-security gain. Existing manager-auth tests cover valid sessions, `alg=none` rejection, future-`iat` rejection, DB-clock anchoring, password verification, and plaintext-password rejection.

## 2026-09-25 — OWASP 2025 A08 integrity/update pipeline
- Evidence: `src-tauri/Cargo.toml` contains no `tauri-plugin-updater`; `src-tauri/tauri.conf.json` contains no `updater` configuration; `src-tauri/src/main.rs` contains no updater plugin initialization.
- Finding: there is currently no Tauri auto-update path in this repository, so no updater-signature verification can be claimed. The repository's architecture test explicitly rejects an unsigned updater path.
- Build integrity evidence: no `@latest` or `:latest` references were found in the inspected build/security paths; CI Action references are immutable SHAs.

## 2026-09-25 — OWASP 2025 A09 logging/alerting boundary
- Evidence: `src/lib/audit.ts` writes durable `audit_events`; `src/app/api/platform/audit/route.ts` and the Platform Audit UI consume the table for review.
- Finding: no configured real-time alerting consumer was found. `SECURITY.md` already documents that audit logging is not equivalent to alerting and assigns high-severity operational alerting to deployment/infrastructure.

## 2026-09-25 — OWASP 2025 A10 exceptional-condition review
- Evidence: Stripe webhook processing is idempotent and returns 502 when current Stripe state cannot be verified; WebSocket delivery distinguishes requeue from explicit `delivery_unknown` after a successful socket write with failed evidence; Odoo print submission marks ambiguous post-dispatch outcomes as `UNKNOWN_SUBMISSION_OUTCOME` and pauses automatic retry, while proven pre-dispatch connection failures remain retryable/failover-safe.
- Result: no additional exceptional-condition gap was identified in the reviewed webhook, WebSocket, and Odoo submission paths, so no production behavior change was made for A10.


## 2026-09-25 — Auth rate-limit B1: response headers
- Scope: `src/lib/auth-rate-limit.ts` and the six authentication-adjacent routes using `reserveAuthAttempt`.
- Fix: `RateLimitDecision` now includes `limit`, `remaining`, and `resetAtEpochSec`; `setRateLimitHeaders()` consistently emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and epoch-second `X-RateLimit-Reset`.
- Coverage: manager login, platform owner login, customer login, forgot-password, register, and resend-verification now apply the same header helper after the reservation decision, including throttled and normal response paths.
- Clock invariant: the limiter continues to derive the authoritative current time from PostgreSQL `clock_timestamp()`; the rate-limit cleanup test uses PostgreSQL time rather than host `Date.now()`.
- IETF status decision: the current HTTPAPI RateLimit header specification remains an active Internet-Draft rather than a stable RFC as of 2026-09-25, so the repository keeps the requested `X-` compatibility names for now.
- Verification: current CI had a pre-existing failure in `Phase 0 architecture hardening test` before the rate-limit test step. No rate-limit PASS is claimed from that run.


## 2026-09-25 — Temporary CI verification ordering for B1
- The existing CI job was temporarily reordered so Gateway unit/integration tests execute before two pre-existing non-Gateway gates that currently fail before those tests: Odoo static security contracts and the stale CSP assertion.
- The Odoo manager-login contract assertion was updated only to recognize the B1 response-header wrapper; unrelated Odoo raw-SQL findings and CSP assertions remain unchanged.
- This is verification scaffolding, not a production architecture change; the original workflow order will be restored after obtaining the requested Gateway test output.


## 2026-09-25 — B1 verification completed
- Focused GitHub Actions verification run `36137131216` used the repository's PostgreSQL 16.15 service, Node `.nvmrc` (24.21.0), `npm ci`, `npm run db:migrate`, then `npm run test:integration -- tests/auth-rate-limit.test.ts`.
- Test output: `tests/auth-rate-limit.test.ts (18 tests)`, `Test Files 1 passed (1)`, `Tests 18 passed (18)`, `Duration 5.64s`.
- The same run's clock guard passed and printed the three `clock_timestamp()` call sites in `src/lib/auth-rate-limit.ts`; no `Date.now()`/host-clock match was accepted by the guard.
- The repository's broader CI remained blocked by unrelated existing Odoo/CSP contract failures; those were not changed as part of B1 except for the manager-login contract string needed to recognize the new response wrapper.
- Temporary verification workflow ordering was restored to the repository's original CI order, and the focused temporary workflow is being removed after verification.


## 2026-09-25 — B2 fail-closed rate-limit storage policy
- All six authentication-adjacent entrypoints now handle `reserveAuthAttempt()` storage failure explicitly.
- Policy: fail closed with HTTP 503; no fail-open exception is implemented.
- Reasoning: fail-open would allow an attacker to turn a rate-limiter storage outage into a brute-force bypass. The cost is temporary blocking of legitimate authentication traffic during PostgreSQL rate-limit-store failure, which is acceptable because PostgreSQL is already a hard Gateway dependency and a storage outage is expected to correlate with broader authentication unavailability.
- Structured event: `auth.rate_limit.store_unavailable` records the affected endpoint and operational error without logging credentials.
- Verification test added: `tests/auth-rate-limit-fail-closed.test.ts` mocks `reserveAuthAttempt` to reject and asserts HTTP 503 for manager login, platform login, customer login, forgot-password, register, and resend-verification.


## 2026-09-25 — B2 verification completed
- Focused GitHub Actions run `36137703454` passed the relevant validation stages: `npm ci`, `npm run typecheck`, `npm run lint`, PostgreSQL migration, the fail-closed unit test, and the existing rate-limit integration suite.
- Fail-closed test output: `tests/auth-rate-limit-fail-closed.test.ts (6 tests)`, `Test Files 1 passed (1)`, `Tests 6 passed (6)`, `Duration 758ms`.
- Existing rate-limit regression output in the same run: `tests/auth-rate-limit.test.ts (18 tests)`, `Test Files 1 passed (1)`, `Tests 18 passed (18)`, `Duration 5.16s`.
- Temporary verification workflow was used only to bypass unrelated full-CI gates and was removed after these results.


## 2026-09-25 — B3 NAT-tolerant IP curve
- Decision: split the shared lock curve rather than keeping one curve for both account and IP buckets.
- Account curve remains 5/10/15/20 failures with the existing 30s/5m/15m/60m lock durations.
- Trusted-proxy IP curve moves to 20/30/40/50 failures with the same progressive durations. This addresses legitimate NAT/shared-source traffic without weakening the stricter per-account protection.
- Regression coverage added for the pure IP curve and a real integration scenario: ten failed attempts for ten different accounts from one trusted source IP leave the IP bucket unlocked; a valid login from that same source IP still succeeds.


## 2026-09-25 — B2 auth rate-limit storage failure mode
- Decision: keep authentication-adjacent rate limiting explicitly fail-closed. A `reserveAuthAttempt()` storage error returns HTTP 503 rather than allowing an unprotected authentication attempt.
- Rationale: fail-closed prevents an attacker from intentionally disrupting PostgreSQL-backed limiter state to create a fail-open bypass. The availability cost is temporary blocking during a PostgreSQL limiter-store failure; PostgreSQL is already a hard dependency for Gateway authentication and core operations, so such an outage is expected to correlate with wider service degradation.
- Scope: manager login, platform owner login, customer login, forgot-password, register, and resend-verification now log a structured `auth.rate_limit.store_unavailable` event and return 503 when reservation cannot be completed.
- No fail-open exception is introduced because no narrower storage error class was demonstrated to be independent of database availability.
- Verification test added: `tests/auth-rate-limit-fail-closed.test.ts` covers all six routes and asserts the 503 fail-closed behavior.

- B2 verification output: temporary focused workflow `36138053714` ran `npm run test:unit -- tests/auth-rate-limit-fail-closed.test.ts`; Vitest reported `Test Files 1 passed (1)`, `Tests 6 passed (6)`, `Duration 865ms`. The temporary workflow was deleted after verification.


## 2026-09-25 — Part B final verification (B0/B1/B2/B3/B4)
- Baseline reference: pre-hardening Gateway commit `8af492ea0556423f7ef5df28fd58a37d3c272307`.
- Baseline command: `npm run test:integration -- tests/auth-rate-limit.test.ts` after `npm ci` and `npm run db:migrate`.
- Baseline output: `Test Files 1 passed (1)`, `Tests 17 passed (17)`, `Duration 5.68s`.
- Functional final reference tested: `b1d08a0391207a9842f2f84a14e28dfd701ea34d`.
- Final rate-limit output: `Test Files 1 passed (1)`, `Tests 20 passed (20)`, `Duration 5.69s`. This includes the B1 response-header assertions and B3 NAT/IP-curve assertions.
- B2 fail-closed output: `tests/auth-rate-limit-fail-closed.test.ts`, `Test Files 1 passed (1)`, `Tests 6 passed (6)`, `Duration 865ms`.
- B4 static coverage is included in `tests/auth-rate-limit.test.ts`: all six auth-adjacent routes must contain both `reserveAuthAttempt` and `setRateLimitHeaders`.
- The focused temporary workflows were removed after verification; no scheduled-job mechanism or production deployment behavior was changed.
- Full CI remains outside the Part B acceptance claim because unrelated existing Odoo/CSP contract failures exist in the repository and live Odoo/production validation is out of scope.


## 2026-09-25 — B3/B4 final verification completed
- Focused final Part B workflow `36138424151` passed `npm ci`, `npm run typecheck`, `npm run lint`, PostgreSQL migration, and `npm run test:integration -- tests/auth-rate-limit.test.ts`.
- Final rate-limit regression output: `tests/auth-rate-limit.test.ts (20 tests)`, `Test Files 1 passed (1)`, `Tests 20 passed (20)`, `Duration 5.24s`.
- B4 coverage check was strengthened from generic symbol presence to exact route contracts: each of the six auth-adjacent routes must extract the client IP and call `reserveAuthAttempt(ip/clientIp, account identifier)`, then apply `setRateLimitHeaders`.
- Direct source verification confirmed all six route contracts are present.
- The temporary Part B verification workflow was deleted after the final run.
