# Production Fix & Verification Report

## Final status

**NOT PRODUCTION READY**

The reported production defects were addressed incrementally on top of the supplied `printer-repo-main-revised-clean-completed.zip`. The remaining blocker is verification environment capability: the repository requires Node >=24.15.0 and Go 1.26, while this environment has Node 22.16.0 and Go 1.23.2; PostgreSQL/Odoo/Windows hardware were not available for full integration/physical verification.

## Root causes and fixes

### A. Agent test print ~10 second delay

**Root cause:** the local Agent `TestPrinter` path performed network discovery before operating on an already-selected printer. The ESC/POS transport also had an optional status preflight on the normal print path. Discovery/preflight latency was therefore able to leak into an interactive test-print operation.

**Fix:** `TestPrinter` now resolves only the selected printer from the persisted local registry/configuration and never runs `DiscoverQuick`. The ESC/POS test page uses the direct RAW TCP byte path with the optional status preflight disabled. The test operation has a bounded 3-second connection context so unreachable devices fail promptly instead of inheriting the normal 10-second production dial budget.

**Verification:** the current Go `NetworkPrinter.Test` implementation was copied into an isolated harness and measured against a local TCP sink/refused port. Healthy path: **2.862 ms**. Refused connection: **0.480 ms**. The repository-native Go regression tests were also added but could not be executed because the installed Go version is 1.23.2 while `agent/go.mod` requires Go 1.26.

### B. Gateway Send Test Page failure

**Root cause found:** the dashboard used the Server Action test-print path, which did not expose the stable HTTP error contract of the existing authenticated printer test endpoint. The repository contained no literal `441` response/code, so an exact runtime 441 could not be reproduced from source alone.

**Fix:** the dashboard now calls `POST /api/printers/:id/test-print` directly. The endpoint remains manager-authenticated and tenant-scoped, validates printer/agent ownership, enforces capabilities/entitlements through the existing job service, returns explicit error codes/statuses, and records `documentType: test_page`. A per-operation `Idempotency-Key` prevents duplicate test-job creation on request retry.

The obsolete `createTestPrintJob` Server Action was removed so there is one dashboard test-print path instead of two competing implementations.

### C. Agent ONLINE after stop/crash

**Root cause:** persisted `agents.status` was not sufficient as a presence truth source after heartbeat loss.

**Fix:** availability is now derived from lifecycle + status + `lastSeenAt` using the shared `agentStaleThresholdSeconds()` rule. A server-side maintenance sweep runs every 15 seconds and persists stale active online agents as `offline`, while request-time APIs also derive effective availability. This avoids stale ONLINE state even before the sweep catches the row.

No historical print jobs are modified by the presence sweep.

### D. Printer status after Agent failure

**Fix:** effective printer availability now depends on its parent Agent's current availability. The manager printer API, agent-detail API, dashboard state, Odoo printer API, and connection diagnostics use the current Agent heartbeat semantics instead of presenting an old raw ONLINE value as live availability.

The `test-connection` diagnostic now reports the Agent heartbeat timestamp rather than a printer-row timestamp as its heartbeat source.

### E. Job semantics

The existing claim-token/job-fencing and unknown-physical-outcome logic was preserved. No historical completed/failed jobs are rewritten when an Agent goes offline. Stale/in-flight physical outcomes remain governed by the existing job-maintenance and claim-fencing rules.

### F. Odoo POS / print path

No speculative endpoint rewrite was made. The existing Odoo 19 route chain was audited and preserved where correct:

- POS receipt: `PosStore.printReceipt()` → `pos.order.action_print_gateway_receipt()` → `route_pos_receipt()` → durable Gateway outbox/job path.
- Kitchen/preparation: `PosStore.printOrderChanges()` → `pos.order.action_print_gateway_kitchen()` → `route_kitchen_print()` → durable Gateway outbox/job path.
- Sale Details: `SaleDetailsButton.onClick()` → `pos.session.action_print_gateway_sale_details()` → `route_pos_sale_details()`.
- Report interception: `report_interceptor.js` → the existing Gateway report routing path.
- Generic report routing: `ir_actions_report.py` → `print_router.route_report()`.

The Odoo 19 source layout was independently checked against the current Odoo 19 repository: `PosStore` is under `point_of_sale/static/src/app/services/pos_store.js`, and the receipt template is `point_of_sale.OrderReceipt`. The supplied module's imports and `_assets_pos` registration match that current layout.

The Odoo runtime itself was not available in this environment, so full browser/POS execution remains **BLOCKED** rather than falsely marked PASS.

### G. UI / AI-looking visuals

Removed the generic `Zap` action/decoration uses from the Gateway/desktop surfaces and replaced them with semantic professional icons such as `Activity` and `Play`. A repository scan found no remaining `Sparkles`, `Wand`, `Bot`, `Stars`, or `Zap` icon component usage in the reviewed UI source.

The Gateway test action now has a real `Sending…` state, disables duplicate clicks while active, and reports submission rather than claiming physical print success prematurely.

## Tests and verification

| Check | Result | Evidence |
|---|---|---|
| Current RAW TCP healthy fast-path measurement | PASS | **2.862 ms** in isolated harness using current `NetworkPrinter.Test` implementation |
| Current RAW TCP refused-connection measurement | PASS | **0.480 ms** in isolated harness |
| Go formatting | PASS | `gofmt -d` clean for modified Go files |
| Odoo Python syntax | PASS | `python3 -m compileall -q odoo_addons` |
| Changed Odoo JS syntax | PASS | `node --check` for modified Odoo JS files |
| TypeScript parser sanity | PASS | `tsc` produced no syntax diagnostics in the modified TS/TSX files |
| Full `npm run typecheck` | BLOCKED | installed dependency tree is incomplete and environment is Node 22.16.0, below required Node >=24.15.0 |
| Vitest unit tests | BLOCKED | repository `node_modules/.bin/vitest` is not installed in the supplied runtime |
| Go repository tests | BLOCKED | Go 1.23.2 cannot execute module requiring Go 1.26 (`GOTOOLCHAIN=local`) |
| Odoo runtime tests | BLOCKED | Python `odoo` package is not installed |
| PostgreSQL integration/migration tests | BLOCKED | no verified repository integration database was available |
| Multi-instance Gateway tests | BLOCKED | PostgreSQL integration environment unavailable |
| Rust/Tauri checks | BLOCKED | `rustc`/`cargo` unavailable |
| Windows installer/service test | BLOCKED | Linux environment; no Windows runtime |
| Physical printer verification | BLOCKED | no physical printer hardware available |

## Changed files on top of supplied ZIP

- `agent/internal/printer/discovery.go`
- `agent/internal/printer/network.go`
- `agent/internal/printer/network_test_fastpath_test.go`
- `server.ts`
- `src/app/actions.ts`
- `src/app/api/agents/[id]/route.ts`
- `src/app/api/agents/route.ts`
- `src/app/api/printers/[id]/test-connection/route.ts`
- `src/app/api/printers/[id]/test-print/route.ts`
- `src/app/api/printers/route.ts`
- `src/app/dashboard/dashboard-client.tsx`
- `src/app/dashboard/page.tsx`
- `src/app/page.tsx`
- `src/desktop/main.tsx`
- `src/desktop/pages/Overview.tsx`
- `src/desktop/pages/Printers.tsx`
- `src/lib/agent-presence-maintenance.ts`
- `src/shared/job-vocabulary.ts`
- `tests/defect-remediation-exhaustive.test.ts`
- `tests/production-fixes-contract.test.ts`
- `PRODUCTION_FIX_VERIFICATION_REPORT.md`

## Database changes

No migration was required. Presence convergence uses the existing `agents.status` and `agents.last_seen_at` fields.

## Remaining limitations

The remaining limitations are verification-only, not silently converted to PASS: complete Node/Next/Vitest validation requires the repository's Node 24.15+ dependency environment; Go validation requires Go 1.26; Odoo execution requires an Odoo 19 runtime; full DB tests require PostgreSQL; Tauri/installer checks require Rust/Windows; physical delivery requires a real printer.

Because those environments are unavailable here, the final status remains **NOT PRODUCTION READY** under the supplied completion protocol.
