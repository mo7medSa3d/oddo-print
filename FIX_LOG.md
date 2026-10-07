RESUME HERE: Task 3 final verification/diff | completed=Task 2 and second adversarial source pass; R01-R09 repaired; local unit/native Node/Python/build checks pass | current=final verification evidence and complete baseline diff review | next=final report; commit/push repair branch; open PR to main; inspect native/live CI | blockers=Go/Rust/Windows/Odoo/PostgreSQL local runtimes absent; physical certification unverified

## 2026-10-07 complete printing audit — execution checkpoint

- Authorized scope: attached `Pasted text(4).txt`; clone latest main, audit/repair the integrated platform, second adversarial review, push a dedicated branch and open a PR to main. Never develop directly on main or discard unrelated changes.
- Repository: https://github.com/mo7medSa3d/oddo-print; baseline `3334590471d3e53e97ab75072624bf1fd2569673`; branch `audit/production-printing-hardening-20261007`.
- Clone completed with `git clone --branch main --single-branch ...`; clean baseline; matching main SHA confirmed through the GitHub connector. No AGENTS.md in repository or workspace ancestors.
- Existing root FIX_LOG.md and AUDIT_FINDINGS.md read completely; previous GW01–GW03 evidence retained below and in the findings file. Archived reviews provide historical evidence only; current source is authoritative.
- Available: Node 24.19.0, npm 11.9.0, Python; Go, cargo, rustc, psql, postgres, Docker and gh absent from PATH. Do not substitute syntax/static checks for live runtime verification.
- Every substantial batch updates this first line before work; every confirmed finding and repair is persisted immediately; final checks and remote publication are recorded here.

### Current-source audit checklist

| Subsystem / boundary | State | Source evidence / limits |
| --- | --- | --- |
| Odoo report/PDF, explicit binding, Test Print, POS, paper geometry | REVIEWED | ir_actions_report/print_router/binding/outbox/POS renderer and assets/ACL/rules; real Odoo/physical geometry remain unverified |
| Windows discovery/service identity/source completeness/identity | REVIEWED | discovery_manager, discovery, spooler/USB/IPP collectors; level-4/level-2 bounds; service identity/per-user candidates; live machine visibility unverified |
| Printer capabilities/status/protocols and execution | REVIEWED | printer-model/health/factory/document, RAW/spooler/PDFium/IPP, cancellation/partial-write/cleanup; R01 repaired; native execution pending CI |
| Inventory sync/stale snapshots/removals/enable-reenable | REVIEWED | heartbeat producer/route, source completeness, desired-state revisions, scoped identity; R02 fixed with durable ordered versions |
| Job admission/dispatch/fencing/idempotency/reconciliation | REVIEWED | job-service/status/delivery/fencing, WS claim/ACK/lifecycle, Agent ledger/queue and Odoo outbox; live DB/runtime tests blocked locally |
| Authentication/RBAC/tenant/company/API-key isolation | REVIEWED | API guard census, public/auth endpoint exceptions, tenant transactions/FKs, WS credentials, Odoo ACL/rules and parameterized SQL, Tauri origin/path rules |
| PostgreSQL/schema/migrations/indexes/transactions | REVIEWED | 25 tables, 81 ordered migrations, tenant-scoped constraints/indexes, locked hot paths; new migration metadata consistent; live migrate/EXPLAIN blocked locally |
| Gateway UI/Desktop/IPC/EN-AR/RTL/menus/auth refresh | REVIEWED | shared Menu/modal keyboard/viewport handling; logical RTL positions/IDs; locale and cancelled refresh; structured errors; native/DOM contracts; visual certification unverified |
| CI/dependencies/deployment/health/TLS/backup/recovery | REVIEWED | five workflows, locks/pins/caches, non-root image/startup/migrate order, strict probe/TLS/WS/CORS, backup/restore safeguards; R04/R06 test gates repaired; live recovery unverified |
| Performance/observability/retention/maintainability | REVIEWED | bounded fleet queries/WS/jobs/discovery; R03 capabilities and R05 presence bounds; payload-free receipts/20-row materialization; redaction/correlation/rotation |
| Targeted adversarial second pass and final diff | COMPLETE | R07/R08/R09 independently found and repaired; changed contracts/fault windows/compatibility checked; final diff and generated snapshot reviewed |

Source review combines full high-risk implementation reads with repository-wide guard/SQL/error/marker/dependency searches. It does not imply physical certification or execution of unavailable runtimes.

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

### Task 2 resumed verification and remaining source review

- Re-read all checkpoint/findings/report files; working tree was clean and HEAD was c37ccf1c with the four repair commits intact. Nothing restarted.
- Full `npm test`: 893 PASS, 1 FAIL (schema-version consumer still asserted 79), 371 SKIPPED. Updated the explicit expectation to migration 80 while preserving the independent latest-journal assertion; rerun required.
- PASS: final typecheck, lint, npm advisory gate (one existing dev-only braces exception with no patched version), EN/AR catalog parity (2376 keys), Odoo Arabic catalog (684 terms), schema/migrations/docs consistency (25 tables, 81 migrations).
- Public/auth route audit: liveness/identity probes disclose no inventory; public plans are caller-independent; token recovery/invitation/registration have rate limits, hashed one-use tokens and transactional consumption; refresh sessions use independent kinds/families, expiry, revocation and tenant lifecycle checks. Agent registration locks a live one-use pairing grant and active subscription before minting a secret. Tenant/company and manager/Odoo credentials remain distinct.
- UI/IPC source review: logical RTL positioning, isolated LTR IDs, shared accessible portaled menus/modals, locale event propagation, cancelled session checks and refresh timers; native command/path/origin allowlists and owned-process checks. Existing DOM/native contracts verify these behaviors; visual Windows/live browser certification remains unverified.
- Retention review: active/pending-outbox/ambiguous fences retained, payload-free Gateway receipts keep duplicate protection; full payload materialization limited to 20 rows; local acknowledgement precedes 48-hour automatic deletion. Logs recursively redact credentials/payloads, hash claim IDs and cap arrays/strings/depth; native logs rotate.
- New R05: stale-Agent presence sweep is unbounded. New R06: substantive Windows-tagged Go tests are compiled out of Linux tests and omitted from Windows CI. Both are being repaired.

- R05 PASS: 9 query/batch-bound/error cases; 54 cases across presence, production contracts and system-health. Added the capped env setting and convergence semantics to operations docs. R06 native module verification/vet/tests precede Windows packaging; execution remains BLOCKED locally. Documented the actual PDF-to-driver page geometry and required physical certification; removed obsolete future-control claims.

### Task 2 verification checkpoint / Task 3 start

- PASS: full Vitest after the schema consumer/presence repairs: 136 files / 897 tests; 45 files / 376 tests SKIPPED, not passes. An earlier full run failed the old schema expectation; the corrected run exited 0.
- PASS: current production Next.js build; Python 210 tests (one rustc-dependent case deliberately DESELECTED/BLOCKED after its environmental failure); pyflakes and compileall exit 0; 10 Odoo XML files parse and manifest data paths exist. Migration journal has 81 ordered SQL files and generated snapshot JSON parses.
- Task 2 source checklist now records actual reviewed boundaries and runtime limitations. Task 3 independently challenges changed code and equivalent consumers; it is not a reread of findings alone.

### Second adversarial pass — first repair checkpoint

- R07 closes the independent DLE EOT 4 paired-sensor validation gap after re-checking the Epson specification; valid DLE EOT 2 single-bit faults remain blocking. Go cases are added, not counted as executed.
- R08 reproduced unsafe raw Unicode/newline HTTP headers and repairs both fleet endpoints with encoded cursor traversal while preserving safe ASCII compatibility; allowed CORS origins can retrieve paging metadata. 27 actual route/HTTP/SQL-predicate/CORS cases PASS; 42 combined cursor/capability regressions PASS. Typecheck/lint and diff whitespace PASS.
- Independently checked int64 precision/exhaustion, Agent clock rollback/restart catch-up, page-1/completion replay, interrupted continuation, legacy downgrade, transaction ordering before heartbeat writes, manager-owned absence fences, cursor tenant/RBAC scope, lookahead discard, batching/locking and workflow native coverage. Further desired-state response-size boundary review is ongoing.

### Second adversarial pass — R09 durable response boundary

- Gateway now queries at most 65 desired-state rows, emits at most 64 / 512 KiB, and offers tenant+Agent+manager-scoped keyset continuations. Modern Agents negotiate paging and accumulate all pages before absence reconciliation. Legacy large snapshots omit the array and require upgrade; small legacy snapshots retain the complete array. No naive truncation.
- Agent continuation has a 45-second deadline, 1 MiB page / 8 MiB aggregate metadata bounds, exact-owner/cursor checks and duplicate/invalid-row rejection. Interrupted, invalid, non-success or oversized snapshots leave the execution fence active and preserve prior desired state. Serialized desired-state writes now enforce the existing 16 MiB read cap, and synchronization only succeeds after persistence.
- PASS: 15 query/route/negotiation regressions (including sentinel-before-projection, byte independent of count, invalid cursor/auth, store failure, legacy and modern boundaries), plus inventory policy/route suites (29 combined in the earlier run). Go all-pages and nine fault cases, cursor/budget and persistence checks added; not counted as executed locally. Docs API/deployment describe rollout, volume budgets and failure behavior.

- Final local verification after R09: 945 Vitest PASS / 371 SKIPPED / 0 FAIL; native Node 101 PASS / 0 SKIP; Python 210 PASS / 1 rustc-dependent BLOCKED; production build, typecheck/lint and DB/docs check PASS. The additional PostgreSQL desired-state scenario is unexecuted locally and adds one blocked test beyond that full-run ledger. Re-fetch of origin/main still equals baseline 33345904. Snapshot comparison/parent chain has only the new inventory column and check, apart from generated IDs.

### Task 4 final review checkpoint

- Full baseline diff reviewed across production code, all affected producers/consumers, regressions, workflows and API/rollout/certification docs; generated snapshot checked structurally against 0079. Original migration history and dependency manifests/locks are unchanged. No unrelated working-tree changes.
- Current-source file anchors appended to findings. Database table-matrix line references refreshed; historical index/FK counts explicitly labelled historical rather than live catalog counts.
- Final report records 9 new findings (P0 0 / P1 1 / P2 8 / P3 0), all source-repaired, with runtime proof limits and the mandatory physical/driver/connection risks. Publication is next.
