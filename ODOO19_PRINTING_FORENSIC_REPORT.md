# Odoo 19 Printing Forensic + Company/Branch/Agent Verification Report

## Executive status

**NOT PRODUCTION READY**

The repository was modified in-place from `printer-repo-final-production-fixed.zip`. The Odoo integration changes are implemented and statically verified, but a full live Odoo 19 install/POS execution and physical printer test could not be executed in this environment because the Odoo runtime, PostgreSQL test stack, Windows runtime, Rust toolchain, Docker, and the required Node/Go toolchain versions are unavailable here.

## Architecture now enforced

```text
Odoo Company
  └─ Gateway URL + installation API key
       ↓
SaaS Gateway
  ├─ Agent A ─ Printer(s)
  ├─ Agent B ─ Printer(s)
  └─ Agent C ─ Printer(s)

Odoo Branch
  └─ inherits Company Gateway connection
       └─ explicit Branch → Agent assignment(s)
            └─ binding selects valid Agent → Printer
```

Company Gateway configuration remains authoritative for Gateway authentication. The API key is restricted to system administrators in the Odoo model and is not returned by the runtime-discovery controllers. Branches do not receive a second Gateway credential.

## Root causes and fixes

### 1. Multiple Agents per Branch were structurally blocked

**Root cause:** `runtime_agent_assignment` previously enforced uniqueness on `(company_id, branch_id)` and the pairing flow replaced the existing branch assignment.

**Fix:** uniqueness is now `(company_id, branch_id, runtime_agent_id)`, pairing is additive, and a Branch can have multiple explicit Agent assignments. Duplicate assignment of the same Agent to the same Branch is rejected by the database constraint.

**Verification:** static contract tests pass; migration `19.0.2.3.0` removes the incompatible legacy unique constraint and creates the new composite unique index.

### 2. Odoo could display Agents not actually assigned to a Branch

**Root cause:** runtime agent discovery could return the Gateway tenant's Agents without filtering them through Odoo's Branch → Agent assignment table.

**Fix:** `/print_gateway/runtime-agents` now intersects Gateway active Agents with enabled assignments for the exact Company/Branch. The runtime-printer endpoint independently enforces the same authorization boundary.

### 3. Arbitrary `agent_id` could be used to request another Agent's printers

**Root cause:** `/print_gateway/runtime-printers` did not prove that the requested Agent was assigned to the current Branch before querying Gateway.

**Fix:** exact `(company_id, branch_id, runtime_agent_id, enabled=true)` assignment is required before Gateway printer discovery. Returned printers are additionally filtered so their Agent identifier exactly matches the selected Agent.

### 4. Printer selection could remain stale when the Agent changed

**Root cause:** the Agent and Printer fields were independently stateful; changing the Agent did not immediately clear the existing Printer selection.

**Fix:** the Agent widget clears `printer_id` as part of the same record update, and the Printer widget clears its local printer list before loading a new Agent scope. Request IDs prevent stale async responses from overwriting the new scope.

### 5. Runtime binding could reference an unassigned Branch Agent

**Root cause:** a persisted binding could potentially survive independently from the Branch assignment map.

**Fix:** binding validation now checks the explicit Branch → Agent assignment. Print routing also performs a fail-closed assignment check at resolution time, so old or manually-created bindings cannot bypass the Branch authorization boundary.

### 6. Pairing wizard could accidentally treat the root Company as a Branch

**Root cause:** the Target Branch field defaulted to the current Company even though the field domain only allows child branches.

**Fix:** the branch default is now empty. A supplied Branch must belong directly to the configured root Company; otherwise the operation is rejected. Company-level runtime assignment remains possible only when no Branch is selected, which preserves standalone-company compatibility.

### 7. Pairing success notification could crash for company-level assignment

**Root cause:** the notification dereferenced `target_branch.name` even when `target_branch` was false.

**Fix:** notification text now safely uses the Branch display name or the configured Company display name.

### 8. Gateway-enabled POS printing could silently fall through to native/browser behavior when a binding was missing

**Root cause:** the POS routing layer returned `native=true` when Gateway mode was enabled but no print binding existed.

**Fix:** Receipt, Kitchen, and Sale Details physical paths are now fail-closed with a clear validation error. The Sale Details HTTP controller also returns a deterministic HTTP 422 JSON error instead of a fake 202 success.

## Odoo 19 printing forensic investigation

### Official Odoo 19 sources consulted

- Odoo 19 POS receipt printer documentation: https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/configuration/epos_printers.html
- Odoo 19 POS receipts: https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/orders/receipts.html
- Odoo 19 POS restaurant/order printing documentation: https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/restaurant/print.html
- Odoo 19 IoT printer documentation: https://www.odoo.com/documentation/19.0/applications/general/iot/devices/printer.html
- Current Odoo 19 POS source: `addons/point_of_sale/static/src/app/services/pos_store.js`

The official Odoo 19 POS source currently resolves receipt printing through `PosStore.printReceipt()` and the printer service; the current source also exposes a `webPrintFallback` option. This repository's Gateway override uses the current Odoo 19 import path and does not call the core printer method when Gateway Printing is active. When Gateway Printing is disabled, the original Odoo path remains available.

### Print mechanisms found in this add-on

The actual project-owned physical print mechanisms are:

1. POS receipt interception through `@point_of_sale/app/services/pos_store`.
2. POS order/preparation printing interception through `printOrderChanges`.
3. POS Sale Details server routing.
4. Odoo report download interception for Gateway-bound reports.
5. Gateway print bindings and the central Python print router.

### Conflicting mechanisms not found in project-owned source

A final source scan of the Odoo add-on (excluding tests and generated Python caches) found no project-owned occurrence of:

- `window.print()`
- `hardware_proxy`
- `iot_longpolling`
- `ePOS`
- `printer_service`
- `odoo.define`
- `Widget.extend`
- `Registries.`
- `web.Widget`
- `QWeb.render`

Odoo's generic native printer/IoT/browser capabilities are not globally deleted. They remain available when Gateway Printing is disabled. For the Gateway-controlled physical POS paths, the custom `PosStore` patch bypasses the native print call instead of invoking it and then falling through to a second printer path.

## POS path verification

### Receipt

```text
POS receipt action
  → PosStore.printReceipt override
  → Gateway-enabled check
  → Odoo server action_print_gateway_receipt
  → Company Gateway credentials
  → Branch binding
  → Agent
  → Printer
```

Gateway-disabled mode delegates to Odoo's original `super.printReceipt(...)` path.

### Kitchen / preparation output

```text
POS preparation changes
  → printOrderChanges override
  → Gateway-enabled check
  → Gateway kitchen endpoint
  → Branch binding
  → Agent
  → Printer
```

Gateway-disabled mode delegates to Odoo's original `super.printOrderChanges(...)` path.

### Sale Details

The project-owned `/pos/sale_details_report` route now fails closed with `gateway_binding_missing` / HTTP 422 when Gateway Printing is enabled but a binding is missing. It no longer returns a misleading 202 response.

### General report/download behavior

The add-on distinguishes Gateway-bound physical/report printing from unrelated Odoo report downloads. The `/report/download` override delegates to Odoo for non-PDF requests and for Gateway-disabled operation. Gateway-enabled bound failures are sanitized and fail closed.

## Company / Branch / Agent behavior

### Company

`print_gateway.gateway_config` is constrained to root Odoo Companies and contains the Company-level Gateway URL/API key and connection-test state. The API key is system-administrator restricted.

### Branch

A Branch inherits the parent Company's Gateway configuration. There is no branch Gateway API key field.

### Agent assignments

`print_gateway.runtime_agent_assignment` is an explicit association table. It can contain multiple enabled rows for the same Branch, one per distinct Gateway Agent identity.

### Agent status

Current Agent status is retrieved from Gateway runtime state. Gateway's Odoo API converts stale heartbeat state to `offline` using the same availability helper used for job authorization.

### Printer status

Gateway's Odoo printer endpoint computes an effective printer state using both the printer state and its parent Agent's current availability. If the Agent is offline/stale, the printer is reported as `offline` rather than falsely remaining online.

## Security boundaries

The modified paths preserve these boundaries:

```text
Company Gateway credential → Odoo server-side only
Branch → explicit Agent assignment
Agent → canonical Gateway runtime identity
Printer → canonical Gateway runtime identity
Print binding → must match current Branch/Agent scope
Frontend values → never treated as tenant authorization
```

## Tests added/updated

- `tests/test_odoo19_printing_static.py` — new Odoo 19 static compatibility and conflict-path suite.
- `odoo_addons/print_gateway/tests/test_architecture_contract.py` — multi-Agent, assignment authorization, UI, and fail-closed routing contracts.
- `odoo_addons/print_gateway/tests/test_branch_runtime_binding.py` — updated Branch/Agent lifecycle expectations and multi-Agent cases.
- `odoo_addons/print_gateway/tests/test_migration_upgrade.py` — migration registration coverage.

## Actual verification results

| Verification | Result | Evidence |
|---|---|---|
| Python AST parse of add-on | PASS | `PY_AST_PASS` |
| Python compileall | PASS | `COMPILEALL_PASS` |
| JavaScript syntax check | PASS | `JS_SYNTAX_PASS` using Node 22.16.0 |
| XML well-formedness | PASS | `XML_WELLFORMED_PASS` |
| Odoo 19 static printing tests | PASS | `5 passed` |
| Project-owned legacy print path scan | PASS | No conflicting occurrences found |
| Gateway API-key response leakage scan | PASS | No runtime-controller leakage found |
| Full pytest suite | BLOCKED | Odoo Python package is not installed (`ModuleNotFoundError: No module named 'odoo'`) |
| Node typecheck/lint/Vitest | BLOCKED | Node `22.16.0`; project requires `>=24.15.0`, and full dependencies are unavailable |
| Go tests/race | BLOCKED | Agent requires Go `1.26`; environment has Go `1.23.2` |
| Rust/Tauri validation | BLOCKED | `rustc` unavailable |
| Docker/integration stack | BLOCKED | Docker unavailable |
| Live Odoo 19 install/upgrade/POS execution | BLOCKED | Odoo runtime unavailable |
| Physical LAN printer test | BLOCKED | No physical printer/runtime environment available |

## Required production verification still pending

A real Odoo 19 runtime should be used to install/upgrade the module and exercise:

1. Company Gateway configuration and Test Connection.
2. Two or more Branch → Agent assignments.
3. Agent A/B selection and exact printer list isolation.
4. Agent offline/reconnect convergence.
5. POS receipt, preparation/kitchen, Sale Details and all other enabled Gateway-bound physical print actions.
6. Gateway unavailable / Agent offline / invalid printer error UX.
7. Actual LAN printer output and duplicate-print prevention.

These are explicitly **not claimed as physically verified** in this report.
