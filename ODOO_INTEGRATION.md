# Odoo Integration Guide

> Module: `print_gateway` | Version: 19.0.2.4.0 | Odoo: 19 Community Edition

## Overview

The Yasser Print Gateway Odoo addon enables silent, hardware-level printing from Odoo ERP to physical printers through the central Gateway. Odoo owns all business context (what to print, where to print); the Gateway owns runtime infrastructure (agents, printers, job queue).

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
| `print_gateway.crypto` | Cryptographic utilities |

## Report Interception (3 Layers)

### Layer 1: ORM Level (`ir_actions_report.py`)
Overrides `report_action()` to intercept `ir.actions.report` execution. If a binding exists, the report is dispatched to the Gateway and a notification is shown instead of opening a PDF.

### Layer 2: HTTP Controller (`report_download_override.py`)
Overrides `/report/download` as defense-in-depth. Catches browser-level PDF download requests that bypass the ORM layer.

### Layer 3: Client-Side JS (`report_interceptor.js`)
OWL 3 `ir.actions.report` handler (sequence 5). Catches report actions in the web client before the default PDF dialog opens.

**Fail-Closed Policy**: If a binding exists but dispatch fails, the native PDF download is cancelled. The operator sees an error notification with a link to the Print Jobs list.

## POS Integration

### Receipt Printing (`pos_print_router.js`)
Patches `PosStore.prototype.printReceipt` to:
1. Check if Gateway printing is enabled for the POS session
2. Render the receipt to a JPEG image (using OWL renderer → canvas → base64)
3. Submit the image to `pos.order.action_print_gateway_receipt`

### Kitchen/Preparation Printing
Patches `PosStore.prototype.printOrderChanges` to route kitchen tickets through the Gateway with per-printer targeting and idempotency keys.

### Sale Details Report (`pos.py`)
Intercepts the `/pos/sale_details_report` route for Z-report printing.

## Binding Configuration

### Hierarchy

```
Root Company
├── Branch A
│   ├── Binding: POS Counter → Agent-1 / Receipt Printer
│   └── Binding: Kitchen → Agent-1 / Kitchen Printer
└── Branch B
    └── Binding: POS Counter → Agent-2 / Receipt Printer
```

### Binding Fields

| Field | Description |
|-------|-------------|
| `company_id` | Root Odoo company (not a branch) |
| `branch_id` | Optional Odoo branch (child company) |
| `destination_type` | POS Config, POS Printer, Operation Type, or Report |
| `runtime_agent_id` | Gateway agent ID |
| `printer_id` | Gateway printer ID |
| `printer_protocol` | Required: escpos, zpl, tspl, raw, spooler, ipp, ipps, unknown |
| `report_id` | Odoo report to render (not for kitchen bindings) |
| `fallback_binding_id` | Pre-dispatch failover if primary printer is offline |

### Validation Rules

- Root company must not be a branch
- Branch must belong to the selected root company
- Agent must be assigned to the branch
- Printer must belong to the selected agent
- POS receipts cannot target laser/inkjet printers
- Kitchen bindings cannot have a report_id

## Print Policy Automation

Policies fire on business events (e.g., `pos_order_paid`) and create durable intents that are dispatched asynchronously:

```python
policies = policy_model.search([
    ("model_id.model", "=", "pos.order"),
    ("event_type", "=", "pos_order_paid"),
    ("company_id", "=", order.company_id.id),
    ("active", "=", True),
])
```

Multi-destination fan-out is supported (same order → receipt printer AND kitchen printer), with same-target deduplication.

## Gateway Configuration

Each root company needs one `gateway_config` record with:
- `gateway_url`: The Gateway's public URL
- `api_key`: An API key created in the Gateway dashboard
- `enabled`: Boolean flag

The config is tested via the Gateway's `/api/odoo/health` endpoint during setup.
