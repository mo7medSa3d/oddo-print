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
