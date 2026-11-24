# Odoo Integration Guide

> Module: `print_gateway` | Version: 19.0.2.37.0 | Odoo: 19 Community Edition


## 19.0.2.33.0: one Branch Devices navigation path

Connection maintenance now contains only repair/reconciliation actions; the Branch Devices page is accessible through the main navigation and the initial setup shortcut, not repeated again inside maintenance. No printer routing, assignments, or job data is changed.

## 19.0.2.32.0: navigation authorization parity with Odoo 19

Opening Branch Devices, Print Routing and Automatic Printing from the company
connection form requires an Odoo system administrator plus **record-read**
access to that connection. Branch-only system administrators may view scoped
navigation without receiving root-company write rights. Ordinary operators
cannot invoke these navigation actions directly by RPC. Company/branch record
rules continue to enforce which assignments, routes and policies are visible.

## 19.0.2.31.0: Odoo 19 compact form and single-company scope correctness

The **Print Routing** Agent picker now declares `printer_id` as a binding-only field dependency. Switching an Agent clears the saved printer in compact or customized Odoo 19 forms. The generic picker used in **Branch Devices** remains independent of `printer_id`, because that model has no printer field.

The native Printer picker now declares `report_id`, legacy `destination_report_id`, computed `document_type`, and `printer_protocol` as field dependencies alongside company, branch, Agent, and destination. This keeps printer capability filtering and protocol selection correctly driven by record values even in compact views. Backend assignment and printer compatibility checks remain authoritative.

The **Automatic Printing** form includes an invisible `company_id` for domain expressions for single-company operators, while presenting the visible company selector to multi-company operators. This follows Odoo 19 view architecture rules. This change does not alter persisted routes, jobs, company assignments or credentials.


## 19.0.2.30.0: deterministic company-wide route priorities

Odoo 19 uses native res.company root/branch records for routing. Print Route priorities must be unique within a company, branch, source and document type. PostgreSQL does not treat an absent Branch as equal to another absent Branch in a regular UNIQUE constraint, so a partial Odoo 19 UniqueIndex now enforces the company-wide case as well. On upgrade, the pre-migration adjusts only conflicting priorities in deterministic (priority, record ID) order; it does not delete routes, change their destinations, change printers, create jobs or call the Gateway. Existing route selection precedence is preserved.

Agent and printer pickers continue to use the Odoo 19 field registry and exact company/branch scope. Empty states link to the current Connection menu, not the retired "Connection & Printing" label.

## 19.0.2.29.0: unified print routing navigation

The retired standalone Printers screen and its client action are removed. Print Routing now owns source, branch, Agent and verified printer selection for invoices, reports, POS and operations. Branch Devices and Automation Activity are first-level menu items; the Advanced menu is retired. On module upgrade a guarded migration removes obsolete menu/action records without deleting Agent assignments, print routes or job history.

## Historical UI notes (retired by 19.0.2.29.0)

The following 19.0.2.22–19.0.2.28 notes describe the now-retired standalone
printer inventory screen. They are preserved as upgrade history, **not** as
current installation or navigation instructions.

### 19.0.2.28.0: previous navigation and scope handling

Document Destinations is now a primary navigation item, separate from the optional Automatic Printing event rules. Branch Devices and Automation Activity remain Advanced. Printer inventory provides branch-scoped recovery guidance and distinguishes missing assignments, unavailable Agents and disconnected printing service. Arabic labels and test-page vs registration-check actions are consistent. Legacy routing, authorization and physical printer requirements are unchanged.


## 19.0.2.27.0: streamlined customer setup

The customer inventory opens to the authorized company/branch. With only one
assignable scope, its name is shown without asking the user to select it again;
multiple scopes remain explicit. Nested branches remain visible but disabled
in the selector and are rejected by the server. Selecting a printer does not
create an Agent assignment. The connection form hides optional explanations
under expandable details while retaining the same authorization and sync state.

## Printer company/branch dropdown repair (19.0.2.22.0)

When separate Odoo companies or branches share the name `My Company`, the
printer selector must show each authorized scope distinctly, including its
company or branch identifier when necessary. The backend returns stable IDs
and explicit root/branch metadata; the OWL selector also disambiguates legacy
duplicate labels. **No company records or printer assignments are merged.**

**Important: this screen is hosted by Odoo, not by the Azure Gateway.**
Updating `test/http-server-ready`, the Gateway container or the Windows
Agent does NOT replace the files of an already-installed Odoo addon. To deploy
this fix, copy the updated `odoo_addons/print_gateway` tree into the running
Odoo 19 instance's configured `addons_path` (preserving Odoo's persistent
data directory and database), take an Odoo database backup, restart its Odoo
workers, and upgrade the module against the correct Odoo database with
`-u print_gateway --stop-after-init` using that instance's normal deployment
procedure. Rebuild/reload Odoo backend assets, then hard-refresh the browser.

To verify, inspect the browser's Network response to
`POST /print_gateway/setup-context`: each `scopes[]` entry should have
the correct distinct `id`, `companyId` and `branchId`, with unique labels.
If the API still returns only `My Company` for all entries, the running Odoo
workers have not loaded this controller update. A simple Gateway restart is
not sufficient. Do not share cookies, authentication tokens or API keys from
the developer tools.

## 19.0.2.25.0: exact RPC IDs, collision-free labels, visible selection

The scope RPC now rejects fractional, boolean, padded, negative or malformed
explicit company/branch IDs instead of coercing them to another Odoo company.
`False`/`None` remains the Odoo convention for an omitted field. Server labels
are checked for collisions after applying disambiguation suffixes (including
literal company names such as `My Company (#2)`). Every option retains its
original `id`, `companyId`, `branchId` and assignment boundary.

The OWL company and agent selectors bind each option's selected state to the
same state values passed to the print APIs. This avoids relying on a `value`
attribute on a `<select>` (which alone does not select an HTML option).
No default/first printer fallback was introduced. This is a source fix, **not**
a claim of actual Odoo browser asset validation: verify the live selector and
that the native `gateway_runtime_agent_binding` and `gateway_runtime_printer`
widgets are present in the recompiled backend bundle after the addon upgrade.

## 19.0.2.24.0: exact branch selection and fail-closed rollout

The revised selector explicitly prefixes **Company** or **Branch** and adds
Odoo record IDs only when human-readable names collide. An action opened for
an explicit branch selects that exact authorized branch, not the parent
company. A revoked or stale scope clears the selection and requires an
explicit new choice; it must not silently switch to the first company.

The existing binding and print-rule schemas accept **direct child branches**
only. Nested branches (grandchildren) are displayed with their full ancestry
but disabled, and controller requests for them fail closed instead of
promoting an intermediate parent to a root. Supporting nested routing
requires a separately tested data-model/authorization migration and is not
certified in this release. Do **not** remove or merge companies to fix labels.

### Non-destructive source-to-Odoo deployment checklist

1. **Identify the actual Odoo database and server** that hosts the installed
   addon, rather than assuming it is the Azure Gateway. Record the configured
   `addons_path`, current module version, PostgreSQL credentials provisioned
   by that instance, and the Odoo service manager. Preserve the persistent
   filestore and encryption keys. The Odoo CLI example below runs on that
   specific server, not on the Gateway.
2. Stop incoming print rule changes/automatic dispatch during the maintenance
   window, and record current queued/unknown intents for reconciliation.
   Take a verified PostgreSQL custom-format database dump and independent
   filestore backup. Restrict both backup files to the operator; test a
   restore into a separate, disposable PostgreSQL database first.
3. Copy **only** `odoo_addons/print_gateway/` from this final V5 source
   into the instance's existing addons location. Verify the manifest version from the **current**
   `odoo_addons/print_gateway/__manifest__.py` (`19.0.2.36.0` in this source)
   there and do not overwrite other addons.
4. With the Odoo HTTP workers stopped according to that instance's
   deployment procedure, run the non-destructive module upgrade against
   the correct database. Substitute real deployment values, not example
   defaults:

   ```bash
   odoo --config "$ODOO_CONFIG" --database "$ODOO_DB" \
     --db-filter "^${ODOO_DB}$" --update print_gateway \
     --stop-after-init --no-http
   ```

   Do not run this command if the destination database, service account,
   configuration or backup has not been established. A failed upgrade must
   be investigated against its own logs before further changes.
5. Restart that Odoo instance's workers through its service manager. Let Odoo
   generate the backend asset bundle, open **Print Routing** with
   `?debug=assets` to inspect the native Agent/Printer picker assets, then reload normally in
   a fresh browser session (bypass stale browser assets). Never delete all
   `ir.attachment` rows or force unrelated module upgrades.
6. In **Print Routing**, select a root company, a direct child branch,
   its assigned Agent and one of that Agent's verified printers. Confirm the
   authenticated `POST /print_gateway/runtime-agents` and
   `POST /print_gateway/runtime-printers` calls use the exact selected
   company/branch and Agent IDs. Test same-name branches, access revocation,
   printer change on Agent switch, a POS binding and an operator-authorized internal printer certification
   through the selected device. The customer-facing Test Page was retired;
   do not restore its menu or button.
   Production confirmation needs a running Odoo 19 environment and hardware;
   static source tests alone are not evidence of rollout.
7. Reconcile pending and unknown print outputs before resuming automatic
   dispatch. Keep the backup and rollback decision point: after any new
   production writes, restoring an old database can lose valid print/financial
   events, so prefer reverting code **only if schema-compatible**, otherwise
   perform a controlled service outage and a reconciled database restore.

For Odoo.sh, deploy the addon through its supported custom-modules branch,
run the Odoo Apps module upgrade on a staging database first, and inspect
its built assets there. Odoo Online does not support arbitrary Python addons.
The Azure Gateway release by itself never updates a separately installed
Odoo addon.

## Overview

The Yaseir Print Gateway Odoo addon enables silent, hardware-level printing from Odoo ERP to physical printers through the central Gateway. Odoo owns all business context (what to print, where to print); the Gateway owns runtime infrastructure (agents, printers, job queue).

## Current operator workflow

The primary Yaseir navigation is **Connection → Print Routing → Branch Devices → Automatic Printing → Print Activity → Automation Activity**. Enter the company connection address and key from Gateway's **Connect Odoo**, assign a printing computer to the exact company/branch under **Branch Devices**, choose a verified Agent and printer under Print Routing for each source, then enable printing. Automatic Printing is optional: it defines business-event triggers, not printer destinations. Checking a connection or registration never proves physical paper output. The Windows pairing code is separate from the Odoo connection key.

The Print Routing form reads assigned computers and verified printers from its native Agent/printer pickers. The legacy authenticated `/print_gateway/setup-context` endpoint is retained for compatibility, but no separate printer inventory page consumes it; it returns no credentials and creates no assignments. A system administrator must explicitly assign a computer to the exact company or branch. A printer becomes selectable only when its existing verification and availability checks pass. Existing server-side branch authorization remains the authority when a rule is saved.

Connection maintenance retains guarded synchronization recovery and branch-computer management. Print Routing, Branch Devices and Automation Activity are direct navigation items. Saved historical lifecycle, diagnostic, output and idempotency evidence is retained. Print Activity uses a separate customer presentation: **Waiting**, **Processing**, **Sent to printer**, **Failed before output**, or **Needs review**. Verified file output remains **File created**. Neither accepted submission nor `success` claims that paper physically emerged.

Customer errors are classified into localized next steps without interpolating raw backend exception text. Arabic translations are evaluated in the current reader's language; raw diagnostic evidence remains available to authorized technical workflows. An uncertain output warns the operator to check before retrying.

Gateway subscriptions are activated manually by the platform owner. A monthly job allowance is independent of the subscription's monthly, yearly or custom contractual term. A quota refusal blocks the current admission and asks the operator to review earlier attempts; it never asserts that previous paper output did not occur.

Document test pages use the selected runtime printer's optional `capabilities.paper_width_mm` (58 or 80) to generate a matching 100mm-long source ticket. The Gateway inventory and Odoo picker retain this physical-media field separately from `printableWidthDots`. Windows spooler tests can use the selected driver's validated paper when roll metadata is unavailable: the Agent tries the document form, then fits the complete page proportionally inside that same driver's printable area before submission. A direct IPP POS/kitchen binding (`pos`/`pos_printer`) with exact `deviceClass=thermal` still requires declared integer58/80mm; no Windows driver is available on that direct path. Other source formats remain: ASCII uses Letter with bounded wrapped metadata, Unicode uses the Odoo report/company paperformat. Names and `document_type` do not establish media. Actual report files retain their layout, while their Windows output uses the same complete-page fit. No global paperformat or installed-printer defaults are modified; submission remains informational until paper is observed.

TSPL Test Print sends the firmware's documented `SELFTEST` command rather than imposing 75×50mm stock or a 2mm gap. ZPL Test Print sends one compact buffered `TEST` label without changing stock, gap or calibration. Actual application label programs are unchanged and still require the printer's real language and configured media. Check registration/Check connection remain control-plane checks; Print test page uses the exact binding and durable physical-job outbox.

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
- POS receipts and kitchen tickets require a rendered-image transport: a real Windows spooler queue (including installed laser/inkjet queues) or a supported ESC/POS network raster path. Direct IPP/USB byte transports and conflicting explicit capabilities are excluded from this JPEG route.

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

## Privileged diagnostic transport compatibility (no customer Test Page)

`Send Test Page` treats the explicitly selected valid binding as authoritative: it validates that binding and its current runtime Agent/printer identity and does **not** independently resolve a second binding to compare against it. The test uses the binding's real document type, then chooses the payload from the printer's current runtime transport—not from a stale protocol field or marketing device class. A Windows-installed queue (`connectionType=spooler`) receives a real PDF through the Agent's Windows document-rendering path, so laser, inkjet, thermal, USB, WSD, and network printers are testable when they are installed as a working Windows queue with a usable driver. IPP/IPPS printers receive PDF through IPP. ESC/POS, ZPL, TSPL, and explicit raw byte transports receive protocol-specific diagnostics. Direct USB/TCP devices with an unknown byte language remain intentionally non-routable: the system will not guess a language or send arbitrary PDF bytes to them.

Printer status and Agent connectivity are separate evidence. A lost/stale Agent heartbeat is displayed as an Agent connectivity problem; it does not rewrite the last printer observation to physical `offline`. Stale printer observations become `unknown` until fresh evidence arrives. Odoo runtime pickers render the Gateway `status` as the current state; `reportedStatus` is retained only for diagnostics/history and is never promoted to current Online/Offline once `freshness` is stale or missing.

The Agent decides which local printers are shared with Gateway. Private queues are excluded from Odoo runtime selectors without deleting saved binding IDs or job history. A stale explicit private binding is unavailable and new dispatch returns `PRINTER_NOT_SHARED`; it does not silently select another printer. Re-sharing restores selection only after a newer Agent snapshot passes Gateway capacity and lifecycle checks. Existing admitted outcomes continue to reconcile; successful submission still requires operator verification of paper output.

### Upgrade gate for print status fairness (19.0.2.13.0)

The `print_gateway.print_job` model now stores and indexes `last_status_polled_at`
to fairly reconcile active Gateway jobs instead of repeatedly polling an oldest-ID
prefix. Existing installations **must upgrade** the addon (`-u print_gateway`)
against a backed-up Odoo 19 database before activating the updated polling cron.
Confirm schema/index creation and test concurrent cron polling, job status
reconciliation, all supported print routes, and rollback in staging. The standalone
source tests do not establish PostgreSQL migration or native Odoo acceptance.

### Why no data-migration folders for 19.0.2.11.0–19.0.2.13.0

Those releases add only nullable columns with safe defaults
(`status_sync_attempted_at`, `allow_additional_pos_output`,
`last_status_polled_at`) plus JS assets. Odoo creates the columns and
indexes during the required `-u print_gateway` above; no row backfill,
rename, or split exists, so no `migrations/19.0.2.1x.0` folder is needed.
A future release that renames a field, splits a column, or rewrites stored
routing keys MUST ship a corresponding migration folder (as 19.0.2.10.0 did
for `destination_ref`/`document_type`).

### Intent company ownership upgrade (19.0.2.14.0)

Upgrade the addon (`-u print_gateway`) before enabling its workers. Intent
`company_id` is now required so company record rules and recovery workers see
the same owned rows. The pre-migration preserves existing ownership and fills
legacy missing companies from the linked outbox job, then the actual source
record for invoice, picking, sale, purchase, and POS flows. A company-wide
policy may match a branch and cannot establish which company owned an event.
Rows without a provable company block the upgrade with sample IDs; restore
their source record or set the verified company before retrying. Back up and
exercise upgrade/rollback on an Odoo 19 database in staging.

### Scheduled automation review (19.0.2.15.0)

The addon defines five native scheduled actions: submit queued jobs, reconcile
Gateway status, recover committed business-event intents, synchronize activation,
and remove retained terminal jobs. Invoice posting, completed inventory moves,
and POS events stage intents inside the business transaction; external dispatch
runs only after commit, with cron recovery for missed callbacks. A rollback must
not print. An intent being dispatched means its durable print job exists; it does
not establish paper output.

Status reconciliation and activation synchronization yield when Odoo 19's
`_commit_progress()` time budget is exhausted. Failed batch-status requests cannot
start a long sequence of individual HTTP requests without another budget check.
Existing retry delays, exact company/binding ownership, and ambiguous physical
outcomes remain authoritative. See the [official Odoo 19 scheduler implementation](https://github.com/odoo/odoo/blob/19.0/odoo/addons/base/models/ir_cron.py).

### Shared typography system (19.0.2.16.0)

The add-on now ships the shared typography system used by the Web console and
the Desktop Manager. The module carries a byte-identical copy of
`typography/tokens.css` (`static/src/css/typography_tokens.css`) and the IBM Plex
families under `static/fonts/`, declared with `@font-face` and
`font-display: block` in `static/src/css/typography_fonts.css`. The font URLs
are module-relative, so the server's PDF engine can fetch them while rendering
a report. A printable document opts in with the `yaseir-typography` class;
Odoo's own reports are untouched.

The POS receipt raster is a deliberate exception and renders exactly as
before: it is a fixed-dot canvas measured against the printer's dot budget,
its metrics are pinned by the measured geometry fixture, and the capture runs
with font embedding disabled, so it must never depend on a web font.

Upgrade with `-u print_gateway` and rebuild/reload the normal Odoo asset bundles
to apply the menu and POS changes. This release changes no schema or dependency;
the 19.0.2.14.0 ownership migration still applies when upgrading older databases.
Validate the scheduled actions through `ir.cron.method_direct_trigger()` in an
Odoo registry test environment, then exercise actual invoice, stock, POS,
multi-company, rollback, outage and recovery flows in staging. Offline source
tests cannot establish native ORM, scheduler, asset or physical-printer acceptance.

## Automatic installation identities (zero-touch Version 2)

**Newly provisioned Gateway workspaces start in strict-v2 automatically.**
Legacy workspaces are NOT automatically converted, even when they appear empty,
because a disconnected Odoo database could still have an external print outbox.
There is no Gateway Installation ID to copy or Version 2 Identity Cutover checkbox for
the customer to activate. Every independent Odoo database/root-company scope
creates its own UUIDv4 and 256-bit installation proof automatically and stores
them in a private JSON file inside the Odoo service's persistent
\`data_dir/yaseir-print-installations/\` directory. The proof never enters
the Odoo database, so a normal database-only clone cannot copy the proof.

On "Test Connection" and at the actual print-job submission boundary, the
addon sends its installation identity over HTTPS to
\`POST /api/odoo/installations/auto\` using the existing Odoo API key.
Enrollment is repeatable and safe to retry after a lost HTTP response. One
Gateway workspace and API key can register multiple Odoo database identities,
even if their Odoo company and operation IDs happen to match.

**Integration activation:** The existing Odoo Enable/Disable state remains scoped
to its API key, not per database. If multiple Odoo databases share one API
key, disabling it in one Odoo database disables printing for all databases
using that key. For independent enable/disable control, issue a separate
Odoo API key for each database. IDs and version cutovers are still automatic
in either case.

**Installation:** Make the Odoo \`data_dir\` persistent and writable by the
Odoo process. Back up its \`yaseir-print-installations/\` credentials using a
separate encrypted/secret backup policy. Do not share that directory between
unrelated Odoo hosts. No customer needs to copy the proof into environment
variables for a fresh deployment.

**Restores:** A database-only clone with a different database name or data
directory gets a new installation identity. All previously persisted print
jobs retain their original identity, and will stop rather than be dispatched
as fresh prints by the clone. Full virtual machine/filesystem clones can
also copy the private identity files, so operators must deliberately rotate
the enrollment after a FULL host clone, not treat it as two independent hosts.

**Existing deployments:** Any pre-existing Gateway workspace still in `legacy`
mode must undergo a separate operator-reviewed cutover. Automatic enrollment
returns a recoverable `RECONCILIATION_REQUIRED` error rather than silently
promoting that workspace. This prevents accidental replay of historical Odoo
outbox jobs that may live outside the Gateway database.

## Installation-scoped idempotency (S06-006)

Starting with forward migration `0085_odoo_installation_idempotency`, independent Odoo databases using one Gateway tenant can opt into a server-enrolled version-2 namespace. Historical v1 operations and lifetime receipts retain their original identities. Tenants already in legacy mode remain there until an administrator explicitly completes the reconciliation and one-way strict cutover; brand-new tenants start in strict-v2 by default.

For a pre-existing legacy workspace, follow a reviewed manual cutover procedure: secure enrollment, external 256-bit installation proofs, API-key rotation, verification of old receipts, operator-controlled `reuse`/`distinct` decisions, and clone/restore restrictions. Never regenerate a key for a pre-existing Odoo outbox job. A pending historical operation requires reconciliation, not a new physical print.

The Gateway installation-management endpoints are `/api/odoo/installations`, `/api/odoo/installations/resolutions`, and `/api/odoo/installations/cutover` (workspace-manager permissions required). Versioned Odoo job submission and status reads continue through the existing `/api/print/jobs` and `/api/print/jobs/v2` routes, with an additional independently enrolled installation identity and proof. Older Agents continue to receive the existing print job and acknowledgment schema; they do not interpret the Odoo source-key version.

### Status reconciliation and identity preservation (19.0.2.18.0)

Status batches are grouped by the **saved** identity version and installation of
each durable job, not by the configuration's current identity. A v2 status read
requires `X-Yaseir-Odoo-Idempotency-Version: 2`, `X-Yaseir-Odoo-Installation`, and
`X-Yaseir-Odoo-Proof`. Missing historical proof stops reconciliation with an
actionable error; it never downgrades the request to tenant-wide authority or
submits a replacement print. Live jobs and retained receipts use the same
installation boundary. Headerless v1 reads remain available only for unmapped
legacy operations while the workspace is still in legacy mode.

Equivalent Gateway URL edits (host case, default HTTPS port or trailing slash)
preserve the stored URL bytes and the external identity-file namespace. A real
endpoint change still follows the existing migration safeguards. Back up the
identity files before upgrades and verify historical pending jobs with the
original proof after a restore. POS activation must resolve to an explicit
boolean before dispatch; an unavailable or malformed activation response must
not trigger browser/native fallback.


### Measured receipt rendering (19.0.2.19.0)

The addon uses the selected printer's versioned geometry and fingerprints image payloads. Unknown widths no longer fall back to 512 dots; physical CSS layout and raster DPI remain separate. Update all application components together and reconcile old operations with their original identity and payload. See `docs/ODOO_RECEIPT_GEOMETRY.md` and `ARCHITECTURE.md` for actual measurement requirements, safe bounds and the supported transport matrix.

### Verified runtime targets and approved PDF file output (19.0.2.20.0)

New work requires a current, identity-bound operational verification from the
Agent. Registration, an `online` label, an open port and configured paper geometry
are not evidence that a destination exists. The Gateway filters its runtime list;
the Odoo controller, cached picker and binding boundary also validate the proof's
printer ID, transport/method, medium and timestamps. A proof and its Gateway
receipt expire after 300 seconds; the source timestamp permits at most 60 seconds
of future clock skew. Cached inventory therefore cannot authorize new work
indefinitely. Keep the hosts' clocks synchronized. This proof establishes the
available execution endpoint, not a successful physical print.

The approved file destination is `connectionType=pdf_output`, `protocol=pdf`,
`printerType=file`, with `outputMedium=file`. Its public configuration contains an
opaque `output_profile_id`; only the Agent administrator maps that ID to an
approved local directory. Odoo receives neither a filesystem path nor a customer
chosen filename. A generic Windows “Print to PDF” queue is not this backend and
remains ineligible for unattended routing.

Sales, refunds, Sale Details and kitchen receipts can select this backend, a
compatible Windows driver, or an explicitly capable direct raster device. They
are not restricted by a thermal/laser/inkjet marketing label. An image sent to file
output needs complete current page geometry: paper width and height, printable
width and height, both DPI values and both imageable offsets, including explicit
zero offsets when appropriate. Ordinary QWeb PDF reports keep their native PDF
representation. The Agent preserves valid PDF input and paginates a receipt
image at its declared physical size; it does not shrink a receipt into a page.
See `docs/ODOO_RECEIPT_GEOMETRY.md` for bounds and the precise transport matrix.

The durable job now stores nullable `output_medium`, `output_outcome` and
`output_evidence` fields. Perform the ordinary `-u print_gateway` update before
activating these assets/workers. No historical payload, idempotency key,
installation proof or accepted operation is rewritten. A status of `file_created`
requires canonical artifact ID, SHA-256, byte count and page count from the
Gateway's verified result. The artifact identity is immutable once accepted.
The Odoo activity view presents file output separately and never converts it to
physical-print success. Missing, malformed or ambiguous file evidence remains
unconfirmed; the existing conservative retry protections remain in force.

Exact authorized replay of an already persisted operation returns that original
payload/job/status before checking new-work eligibility. It cannot reformat the
receipt, create another job or replace its fingerprint. Current company, source
record, route identity and read permissions still apply. New operations require
a fresh operational proof and the current geometry fingerprint.
