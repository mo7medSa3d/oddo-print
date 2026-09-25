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
