# Odoo Integration Guide

> Module: `print_gateway` | Version: 19.0.2.11.0 | Odoo: 19 Community Edition

## Overview

The Yaseir Print Gateway Odoo addon enables silent, hardware-level printing from Odoo ERP to physical printers through the central Gateway. Odoo owns all business context (what to print, where to print); the Gateway owns runtime infrastructure (agents, printers, job queue).

## Architecture

```
Odoo 19 ──────────────────────────────────────────────┐
│ Gateway Config (URL + API key per root company)     │
│ Binding (Company/Branch/Destination → Agent/Printer)│
│ Print Router (rendering + dispatch)                 │
│ Print Policy (event-driven automation)              │
│ Print Intent (durable outbox)                       │
└─────────┬───────────────────────────────────────────┘
          │ HTTPS API calls
          ▼
     Gateway (job queue, claim fencing, agent delivery)
          │
          ▼
     Go Agent (physical print execution)
```

## Models

| Model | Purpose |
|-------|---------|
| `print_gateway.gateway_config` | Gateway connection (URL + API key) per root company |
| `print_gateway.binding` | Maps (Company, Branch, Destination, Document Type) → (Agent, Printer) |
| `print_gateway.policy` | Event-driven print automation rules |
| `print_gateway.intent` | Durable outbox for asynchronous dispatch |
| `print_gateway.print_job` | Odoo-side job tracking |
| `print_gateway.runtime_agent_assignment` | Branch → Agent mapping |
| `print_gateway.pair_agent_wizard` | Guided Gateway agent pairing flow |
| _`print_gateway.crypto`_ | AES-GCM utility module (not a model) |

## Report Interception (2 Layers)

### Layer 1: ORM Level (`ir_actions_report.py`)
Overrides `report_action()` to intercept `ir.actions.report` execution. If a binding exists, the report is dispatched to the Gateway and a notification is shown instead of opening a PDF.

### Layer 2: Client-Side JS (`report_interceptor.js`)
Uses the supported Odoo 19 client-side report action interception path to stop the native PDF download flow when Gateway printing is selected.

Odoo's native `/report/download` HTTP controller remains untouched.

**Fail-Closed Policy**: If a binding exists but dispatch fails, the native PDF download is cancelled. The operator sees an error notification with a link to the Print Jobs list.

## POS Integration

### Receipt Printing (`pos_print_router.js`)
Patches `PosStore.prototype.printReceipt` to:
1. Check if Gateway printing is enabled for the POS session
2. Render the receipt to a JPEG image (using OWL renderer → canvas → base64)
3. Submit the image to `pos.order.action_print_gateway_receipt`

### Kitchen/Preparation Printing
Patches `PosStore.prototype.printChanges` so Gateway-enabled POS kitchen tickets preserve Odoo 19's native `pos.printer`/product-category routing; the native `pos.printer` is the logical preparation destination, while the Gateway Runtime Printer is the physical target.

### Sale Details Report (`pos.py`)
Intercepts the `/pos/sale_details_report` route for Z-report printing.

## Binding Configuration

### Hierarchy

```
Root Company
├── Branch A
│   ├── Binding: POS Counter → Agent-1 / Receipt Printer
│   └── Binding: Kitchen → Agent-1 / Gateway Runtime Printer
└── Branch B
    └── Binding: POS Counter → Agent-2 / Receipt Printer
```

### Binding Fields

| Field | Description |
|-------|-------------|
| `company_id` | Root Odoo company (not a branch) |
| `branch_id` | Optional Odoo branch (child company) |
| `destination_type` | POS Receipt, POS Kitchen / Preparation, Operation Type, or Report |
| `runtime_agent_id` | Gateway agent ID |
| `printer_id` | Gateway printer ID |
| `printer_protocol` | Required: escpos, zpl, tspl, raw, spooler, windows_spooler, ipp, ipps, unknown |
| `report_id` | Single operator-facing Odoo report selector for backend/document bindings; POS Receipt and POS Kitchen / Preparation bindings do not require a report |
| `fallback_binding_id` | Pre-dispatch failover if primary printer is offline |

### Validation Rules

- Root company must not be a branch
- Branch must belong to the selected root company
- A Branch binding requires an Agent assigned to that exact Branch; a Company-only binding may use any Agent assigned to the Company or one of its direct child Branches
- Printer must belong to the selected agent
- POS Receipt bindings are rendered by the POS client and do not require a PDF report
- POS Kitchen / Preparation bindings use the native Odoo 19 Preparation Printer as the logical category-aware destination and the Gateway Runtime Printer as the physical target
- An Odoo 19 `pos.printer` is required when using category-aware Gateway Kitchen / Preparation routing; a POS Shop binding remains available only as a compatibility fallback when no native Preparation Printer binding exists
- POS receipts and kitchen tickets cannot target laser/inkjet printers

## Print Policy Automation

Policies fire on business events (e.g., `pos_order_paid`) and create durable intents that are dispatched asynchronously:

```python
# Branch-aware lookup: root company + branch scope (see
# print_policy.resolve_for_record), not the bare order company.
root_company = order.company_id.parent_id or order.company_id
branch = order.company_id if order.company_id.parent_id else False
policies = policy_model.search([
    ("model_id.model", "=", "pos.order"),
    ("event_type", "=", "pos_order_paid"),
    ("company_id", "=", root_company.id),
    ("branch_id", "in", [False, branch.id] if branch else [False]),
    ("active", "=", True),
])
```

Multi-destination fan-out is supported (same order → receipt printer AND kitchen printer), with same-target deduplication.

## Gateway Configuration

Each root company needs one `gateway_config` record with:
- `gateway_url`: The Gateway's public URL
- `gateway_api_key`: The installation API key created in the Gateway dashboard
- `enabled`: Boolean flag

The config is tested via the Gateway's `/api/odoo/health` endpoint during setup.

### Report Destination
For `destination_type = Report`, the operator selects exactly one `Report`. The legacy `destination_report_id` field is retained only for compatibility with pre-2.10 data and is hidden from the form.

Discovery reports use the additive `errors: string[]` contract in `contracts/print-payload-contract.json` (maximum 64 messages, 2048 UTF-16 units each). The Gateway returns these in session `stats.errors`; optional unavailable device fields are omitted, and protocol defaults to `unknown`. Odoo consumes approved runtime printers, not discovery candidates or source diagnostics; no addon producer emits discovery reports.

## Diagnostic test-print compatibility

`Send Test Page` treats the explicitly selected valid binding as authoritative: it validates that binding and its current runtime Agent/printer identity and does **not** independently resolve a second binding to compare against it. The test uses the binding's real document type, then chooses the payload from the printer's current runtime transport—not from a stale protocol field or marketing device class. A Windows-installed queue (`connectionType=spooler`) receives a real PDF through the Agent's Windows document-rendering path, so laser, inkjet, thermal, USB, WSD, and network printers are testable when they are installed as a working Windows queue with a usable driver. IPP/IPPS printers receive PDF through IPP. ESC/POS, ZPL, TSPL, and explicit raw byte transports receive protocol-specific diagnostics. Direct USB/TCP devices with an unknown byte language remain intentionally non-routable: the system will not guess a language or send arbitrary PDF bytes to them.

Printer status and Agent connectivity are separate evidence. A lost/stale Agent heartbeat is displayed as an Agent connectivity problem; it does not rewrite the last printer observation to physical `offline`. Stale printer observations become `unknown` until fresh evidence arrives. Odoo runtime pickers render the Gateway `status` as the current state; `reportedStatus` is retained only for diagnostics/history and is never promoted to current Online/Offline once `freshness` is stale or missing.
