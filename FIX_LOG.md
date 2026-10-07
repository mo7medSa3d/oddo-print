RESUME HERE: Phase 1 remaining source audit | completed=R01-R04 repairs; inventory/capability regressions; all 101 native Node cases pass | current=Odoo/POS/document fidelity, security, UI/IPC and deployment source review | next=record subsystem evidence; full runnable verification; adversarial second pass; then commit/push/open PR | blockers=Go/Rust/Windows/Odoo/PostgreSQL runtimes absent; physical page fidelity unverified; original PC connection failure unconfirmed

## 2026-10-07 complete printing audit — execution checkpoint

- Authorized scope: attached `Pasted text(4).txt`; clone latest main, audit/repair the integrated platform, second adversarial review, push a dedicated branch and open a PR to main. Never develop directly on main or discard unrelated changes.
- Repository: https://github.com/mo7medSa3d/oddo-print; baseline `3334590471d3e53e97ab75072624bf1fd2569673`; branch `audit/production-printing-hardening-20261007`.
- Clone completed with `git clone --branch main --single-branch ...`; clean baseline; matching main SHA confirmed through the GitHub connector. No AGENTS.md in repository or workspace ancestors.
- Existing root FIX_LOG.md and AUDIT_FINDINGS.md read completely; previous GW01–GW03 evidence retained below and in the findings file. Archived reviews provide historical evidence only; current source is authoritative.
- Available: Node 24.19.0, npm 11.9.0, Python; Go, cargo, rustc, psql, postgres, Docker and gh absent from PATH. Do not substitute syntax/static checks for live runtime verification.
- Every substantial batch updates this first line before work; every confirmed finding and repair is persisted immediately; final checks and remote publication are recorded here.

### Current-source audit checklist

| Subsystem / boundary | State | Evidence to inspect |
| --- | --- | --- |
| Odoo report/PDF, explicit binding, Test Print, POS, paper geometry | PENDING | addon models/controllers/assets/security/report generation and consumers |
| Windows discovery/service identity/source completeness/identity | PENDING | agent printer sources, normalization, service account diagnostics |
| Printer capabilities/status/protocols and execution | PENDING | spooler/RAW/IPP/ESC-POS, supported formats, cleanup/cancellation |
| Inventory sync/stale snapshots/removals/enable-reenable | PENDING | agent producers, Gateway validation, migrations, frontend/Odoo consumers |
| Job admission/dispatch/fencing/idempotency/reconciliation | PENDING | APIs, workers, websocket, local persistence, retries and retention |
| Authentication/RBAC/tenant/company/API-key isolation | PENDING | all API guards, SQL scoping, Odoo ACL/rules, WS identity |
| PostgreSQL/schema/migrations/indexes/transactions | PENDING | schema, migration order, actual hot-path predicates |
| Gateway UI/Desktop/IPC/EN-AR/RTL/menus/auth refresh | PENDING | components, routes, Tauri commands, native configuration |
| CI/dependencies/deployment/health/TLS/backup/recovery | PENDING | workflows, lockfiles, services, scripts, shutdown |
| Performance/observability/retention/maintainability | PENDING | bounded work, cache ownership, log redaction, active-job safety |
| Targeted adversarial second pass and final diff | PENDING | changed code and subsystem boundaries, fault windows |

### Verification ledger — this audit

| Command / check | Result |
| --- | --- |
| clone main / git status / git log / connector main SHA | PASS; clean baseline, SHA above |
| node --version / npm --version | PASS; versions above |
| command -v go cargo rustc psql postgres docker gh | UNVERIFIED runtime suites; executables absent |
| npm ci --no-audit --no-fund | PASS; 464 lockfile-approved packages; package files unchanged |
| npm run test:unit | PASS; 127 files / 840 tests; 1 file / 6 tests skipped (not passes) |
| npm run typecheck; npm run lint | PASS; exit 0 |
| node --test tests/*.test.mjs | FAIL invocation: VM module flag required; corrected below |
| node --experimental-vm-modules --test tests/*.test.mjs | FAIL; 100 pass / 1 stale contract assertion (R04), missing in current CI glob |
| python3 -m pytest -q tests | BLOCKED initially: pytest missing; CI declares exact verification dependencies, checking their availability separately |

### Discovery/inventory and admission batch evidence

- Source map: Odoo QWeb/POS -> print_job durable outbox -> `/api/print/jobs` -> `print-job-service.ts` -> PostgreSQL jobs/receipts and tenant/agent advisory locks -> poll/WS claim in `job-delivery.ts` -> local Agent queue/SQLite ledger -> `printer.Document` -> Windows GDI/PDFium, RAW, or IPP -> fenced `/api/agent/jobs` -> Odoo polling/UI.
- Discovery: live/config/spooler/USB/network/IPP/mDNS/SNMP/WSD collectors, source-specific completeness, candidate-vs-runnable filtering, durable registry, paginated heartbeat, desired-state revisions, Gateway validation and tenant+Agent-scoped identity. Partial results are retained; candidate evidence does not authorize a transport. Windows level-4 enumeration + bounded level-2 enrichment and interactive per-user candidate separation are implemented.
- Confirmed R02: page 1 always replaces the prior snapshot, and final page clears its fence. A delayed/replayed older page 1 can overwrite newer data or retire all inventory. Introduce a decimal-string int64 version retained on the Agent row; reject stale versions before any writes, protect continuations, and allow explicit Agent catch-up after clock rollback/restart. Legacy clients remain additive and cannot authorize absence.
- Confirmed R01: ESC/POS health code decodes fault bits even when the fixed response framing is invalid, turning garbage/echo into false offline/paper/cover evidence.
- Confirmed R03: `/api/printers/capabilities` selects and projects the entire fleet; timeout does not cap cardinality.
- Confirmed R04: CI executes only `audit-*-offline.test.mjs`; 101 native Node cases exist. Full glob exposed an obsolete getDashboardState assertion after the structured-result API change.
- Microsoft references inspected: https://learn.microsoft.com/en-us/windows/win32/printdocs/enumprinters ; https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter . They support caller-context queue enumeration, blocking spooler calls and distinct RAW/driver semantics. Physical paper output is still unverified.

### R02 repair checkpoint

- Added a retained, checked decimal int64 snapshot version (schema/migration/snapshot/journal). Gateway validates the version under the Agent row lock before all mutations; continuation pages require matching version plus existing ID/page fence. Final completion retains the version. Legacy reports remain additive until a versioned writer is established; downgrade is then refused.
- Agent creates monotonically increasing versions, shares them across pages, and observes the Gateway's minimum version after a 409 so clock rollback/restart can recover on the next cycle. Counter exhaustion stays fail-closed. No reliance on synchronized clocks.
- Added 18 executable policy/actual-route cases for precision, malformed versions, stale page 1, duplicate completed snapshots, continuations and downgrade; added PostgreSQL integration scenarios and Go concurrency/rollback/restart cases (runtime execution still blocked).
- PASS: targeted inventory unit suites; typecheck; `git diff --check`. Generated migration with the project-approved Drizzle CLI. `npm run db:generate` was blocked by tsx IPC `EPERM`; equivalent `DATABASE_URL=<local dummy> node --import tsx scripts/db-generate.ts --name inventory_snapshot_version` succeeded without connecting to a DB. SQL/snapshot diff contains only the new column/check.
- PASS: baseline production Next.js build with the real dependency tree (compiled/prerendered; no live DB claim).
- Exact CI-declared Python verification dependencies installed into scratch only (`pytest==9.1.1`, `pytest-asyncio==1.4.0`, `pyflakes==4.0.2`); no project dependency changes. Full Python invocation: 210 PASS, one environment FAIL because `test_tauri_std_audit.py` needs missing rustc. That case remains BLOCKED, not repaired by weakening the test.

### R01 repair checkpoint

- Invalid DLE EOT response framing now yields status-unsupported before decoding any fault bit; valid offline/cover/paper/error evidence still stops transmission. Reviewed both network printing and Status/preflight consumers: optional unsupported health responses do not become asserted hardware failure or health proof.
- Added invalid fault-looking replies for all three inquiries and valid-fault controls; updated the existing TCP test's garbage case to the unsupported-status behavior. Go test/race execution remains BLOCKED locally; source/test changes are committed for CI, not represented as passes.

### R03 repair checkpoint

- Replaced the unbounded capabilities query with tenant-scoped ascending-ID keyset pages (100 default, 1000 maximum, one lookahead row). The existing tenant+ID unique index supports this predicate/order; no new index is justified.
- Limits apply before diagnostics are built; sentinel rows are discarded before projection. Responses remain arrays with no-store, X-Has-More and a canonical base64url X-Next-Cursor. UTF-8/Unicode IDs cannot break headers. Direct printerId reads and permissions remain scoped.
- PASS: 15 executable query/route regressions including bounds, sentinel discard, tenant predicate, cursor, Unicode, bad cursors, authentication and RBAC. Desktop Vite production bundle also PASS (native Tauri remains BLOCKED).
- Odoo rendering/binding source review confirms native QWeb PDF bytes, source-record read checks, company/branch restrictions, explicit binding validation and selected Test Print binding. Physical PDF rendering fits the configured Windows driver printable area; arbitrary browser dialog settings cannot be captured and exact physical custom-size/margin/font output remains a required live certification item.
- Authoritative ESC/POS framing reference inspected: https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/dle_eot.html (fixed bits before status interpretation).

### R04 repair checkpoint

- CI now invokes all `tests/*.test.mjs` with `--experimental-vm-modules`, covering session/ownership, fleet/status, retention, installer, UI, contract and offline audit regressions. The client fleet contract follows the structured-result wrapper and currentQuery while retaining the shared bounded query and pagination requirements.
- PASS: all 101 native Node tests, 0 skips, 0 failures. This replaces the baseline 100/1 stale assertion result; no behavioral gate was removed.


## 2026-10-07 Gateway connection report

- Base: main at 1a4dbc7f7a6387eae7723fd3a2859e5f84006e5e.
- The supplied Manager log confirms local service startup but contains no Gateway check outcome.
- Confirmed: native candidate probes return errors without logging their cause; reqwest Display omits nested transport causes.
- Confirmed: Settings and Agents re-map already localized Gateway errors to the generic fallback.
- Confirmed: passing errMsg(error) discards HTTP status attached to GatewayApiError.
- Live checks of https://print.yaseir.cloud/api/agent/probe (including Origin: tauri://localhost) and /api/health returned HTTP 200. The reported Windows connection failure is not yet reproduced; diagnostics repairs do not prove it resolved.
- Keep the dedicated probe contract; do not reintroduce the reverted health fallback or change TLS verification.
- Repairs implemented: preserve structured HTTP failures during localization; render safe localized state once in Settings/Agents; log candidate probe start, HTTP outcome, elapsed time, sanitized request ID and bounded transport cause chains.
- Verification: 5 Node regression tests passed (HTTP status in en/ar, transport causes, strict probe identity, configuration retention on failure, diagnostic logging contract); 5 existing draft contracts passed by direct Python invocation. No dependencies were installed.
- UNVERIFIED locally: full typecheck/lint/build and Rust compilation/tests, because project dependencies and the Rust toolchain are not installed. Existing GitHub CI/Windows workflows will verify the published commit.
- Published c1d7d7e708c1aead6c4aac4e327c6482ccc68718 directly to main. GitHub typecheck, Go vet/race, CodeQL/secret/supply-chain scans and PostgreSQL failure injection passed. CI lint rejected the new test helper's local variable named module (Next.js reserved-variable rule); renamed it loadedModule and all 5 Node regression cases passed again. Windows Rust verification was still running at this checkpoint.
