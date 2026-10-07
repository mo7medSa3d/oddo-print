# Complete printing audit — 2026-10-07

Repository: https://github.com/mo7medSa3d/oddo-print
Baseline: `3334590471d3e53e97ab75072624bf1fd2569673` (latest main at clone; unchanged on final fetch).
Branch: `audit/production-printing-hardening-20261007`.

Source audit, repairs, runnable local verification and the independent second adversarial pass are complete. Publication is the remaining Task 4 step. Native/live checks are **BLOCKED locally**, not passed. Physical printing is **UNVERIFIED**. This report makes no physical production-certification claim.

## Findings

New findings: **P0 0 / P1 1 / P2 8 / P3 0**. All nine have source repairs and regressions. No known unresolved P0/P1 remains in the reviewed source. Runtime confirmation for native/database changes remains subject to the gates below. Prior GW01–GW03 are preserved as historical P2 findings, separate from these counts; the original user's Windows connection failure is still unconfirmed.

| ID | Severity | Root cause and final repair | Commit |
| --- | --- | --- | --- |
| R01 | P2 | Invalid ESC/POS framing asserted offline/paper/cover faults; invalid replies now mean unsupported status before bit interpretation. | a1a074c0 |
| R02 | P1 | Random snapshot IDs cannot order page-1/completed replays; retain a checked int64 decimal high-water mark under the Agent row lock, shared across pages, with rollback/restart catch-up. Legacy writers cannot authorize absence or downgrade the fence. | 0e263bc4 |
| R03 | P2 | Capabilities selected/projected the entire fleet; tenant-scoped keyset pages apply limits before diagnostics and publish safe cursors. | 90173551 |
| R04 | P2 | CI's audit-only filename glob omitted native Node regressions; run all 101 cases and retain the current fleet-query contract. | c37ccf1c |
| R05 | P2 | Stale-Agent persistence updated/returned the entire backlog; ordered capped batches use SKIP LOCKED while request-time freshness stays immediate. | 1771d2b5 |
| R06 | P2 | Windows-tagged Go regressions never executed; native module verification, vet and tests now precede Windows packaging. | cc487bd5 |
| R07 | P2 | Valid fixed framing still admitted undefined DLE EOT 4 sensor half-pairs; reject those pairs before hardware fault interpretation, retain valid near-end/fault controls. | 4dab2874 |
| R08 | P2 | Unicode/control IDs broke raw cursor headers and CORS hid traversal metadata; encoded UTF-8 cursors work on both fleet routes, with safe ASCII compatibility and allowed-origin exposure. | eae77c5d |
| R09 | P2 | Paginated inventory uploads returned an unbounded authoritative desired-state list; negotiated bounded continuation pages are collected and persisted before absence reconciliation. Invalid/interrupted/unpersisted snapshots keep execution fenced. | e7cf576a |

Details, regression evidence and final file:line anchors are in `AUDIT_FINDINGS.md`. Batch history and interrupted/failed invocations remain in `FIX_LOG.md`.

## Integrated source review

The repository was treated as one distributed printing system. High-risk implementations were read directly; repository-wide API guard, SQL, error-handling, marker, dependency and workflow searches supplemented those reads. The review does not claim that static inspection executes a missing runtime.

| Area | Traced implementation and conclusion |
| --- | --- |
| Odoo standard reports | QWeb PDF generation, source-record read access, company/branch binding resolution, native download behavior, durable print intent/outbox and Gateway submission. The report path preserves native QWeb PDF bytes. |
| Test Print | The selected explicit Odoo binding is checked before rendering/queueing. Gateway Test Print is manager/RBAC scoped, protocol/capability checked and idempotent, with no queued-job claim on fail-fast refusal. |
| POS and kitchen | Actual OWL receipt rasterization, font/readiness waits, receipt/reprint/bill hooks, kitchen operation identity and unknown-outcome controls. Enabled Gateway failures surface instead of silently falling back to browser printing. |
| Windows discovery | Level-4 enumeration, bounded level-2 enrichment, retained unreadable/partial sources, service SID/context, interactive per-user candidates, SetupAPI USB identity, network/IPP/mDNS/SNMP/WSD normalization. Candidates do not authorize execution; an empty partial discovery does not prove absence. |
| Printer identity/inventory | Stable hardware/endpoint evidence, tenant+Agent ownership, aliases, source completeness, desired revisions, disable/retire/re-enable and Gateway-owned deletion fences; R02 closes stale full-snapshot replay. |
| Protocols/capabilities/status | RAW/ESC-POS/ZPL/TSPL versus driver PDF/image and IPP/IPPS contracts, explicit passthrough opt-in, observed capabilities and freshness. TCP/WS connectivity is not hardware-health proof; unsupported status stays unknown. |
| Windows execution | Bounded preflight, per-printer serialization, RAW partial-write abort/fencing, spooler job identity, embedded PDFium/GDI rendering, cancellation and resource/temp-file cleanup. Submission success is not verified paper output. |
| Job lifecycle/reconnect | Tenant-scoped idempotency fingerprints and payload-free receipts, quota/admission locks, poll/WS claim tokens, delivery evidence/ACKs, durable SQLite admission/outbox, execution authorization, terminal reconciliation and manual reprint. Ambiguous post-delivery attempts are not automatically requeued. |
| Security | API guards including intentional public/auth exceptions, hashed one-use pairing/recovery grants, refresh-family reuse/revocation, manager/customer/platform/Odoo/Agent separation, tenant lifecycle and composite FKs, Odoo ACL/rules/parameterized SQL, native IPC/path/origin/owned-process controls. |
| Database | 25 current tables, 81 ordered migrations, actual hot-path tenant/Agent/idempotency/freshness predicates, locking and indexes. Migration 0080 is additive and preserves exact int64 values in JSON. Existing migrations/locks were not rewritten. |
| Gateway UI/Desktop | Shared keyboard/viewport-aware portaled menus/modals, logical RTL positioning, isolated LTR technical IDs, locale navigation, bounded fleet reads, cancelled session checks/refresh, structured localized errors and native command contracts. Live visual certification remains unverified. |
| Scale/observability/retention | Bounded fleet queries, WS sockets/frames/in-flight work, discovery and claims; R03/R05/R09 bound previously unbounded paths. Job cleanup retains active/ambiguous fences, materializes at most 20 payload rows per inner batch, keeps receipts, and waits for local acknowledgement. Logs redact credentials/payloads, hash claim IDs, cap structures and rotate native files. |
| CI/deployment/recovery | Five workflows, manifests/lockfiles/pinned tools and actions, caches, non-root image, migration/startup ordering, readiness/liveness, TLS/WS/CORS, graceful shutdown, restrictive backup artifacts and restore safeguards. Live restore/DR remains unverified. |

No fabricated throughput or physical benchmark figures are used. Source/SQL bounds cover small and thousand-printer fleets; native metadata/process budgets remain explicit. No speculative schema index, dependency upgrade, UI rewrite, TLS bypass or browser fallback was introduced.

## Verification ledger

| Verification | Evidence/result |
| --- | --- |
| Git baseline/working tree/commit checks | Clean clone; dedicated repair branch; all prior checkpoint commits retained; final origin/main still equals the baseline. |
| Lockfile install | PASS: npm ci; project-approved dependencies only; manifests and lockfiles unchanged. |
| Full final Vitest | PASS: **945 passed, 371 skipped, 0 failed**. Skipped cases are not passes. A newly added PG desired-state case is separately blocked locally. |
| Native Node suite | PASS: **101 passed, 0 failed, 0 skipped**, with the VM flag and the exact full glob now used in CI. |
| Python static contracts | PASS: **210 passed**. One rustc-dependent test failed environmentally in the full attempt, then was explicitly deselected/BLOCKED in the final runnable run. It is not represented as passing. |
| TypeScript / ESLint | PASS: current production source and tests. |
| Production Next.js build | PASS: compilation/prerendering, including the new Agent continuation route; not a live database claim. |
| Desktop Vite bundle | PASS earlier in this audit; desktop UI source is unchanged. Native Tauri remains blocked locally. |
| Python syntax/static / Odoo files | PASS: pyflakes, compileall, 10 XML files parsed, manifest data paths exist. |
| EN/AR catalogs | PASS: Gateway 2376 keys per locale; Odoo 684 source terms/catalog entries. |
| DB/schema/docs/migration metadata | PASS: 25 tables / 81 migrations; ordered journal/SQL files; generated parent chain. Snapshot structural comparison contains only the inventory version column/check besides generated IDs. Live migration is blocked locally. |
| NPM advisory gate | PASS: no unlisted high/critical advisories. The existing lockfile-proven dev-only braces exception has no patched version and is absent from the runtime image. |
| Diff review | PASS: intended production source/tests/docs only; generated snapshot reviewed structurally; whitespace check passes; no dependency/lockfile changes. |

Earlier failures are retained truthfully: the unflagged Node invocation required VM modules; the full Node run exposed a stale fleet assertion; full Vitest exposed the old schema-version expectation; Python exposed missing rustc. Corrections were executed and retested where the runtime exists. None of those failures, interrupted invocations or skipped tests became assumed passes.

## Independent second adversarial pass

The second pass inspected changed code and equivalent producers/consumers rather than only rereading the findings list. It found and repaired R07, R08 and R09.

- Challenged adjacent int64 values beyond JS precision, counter exhaustion, rollback/restart, old/equal page-1 and completed-snapshot replay, wrong continuation version/ID/count/page, partial failures, downgrade and concurrent writers. Validation precedes heartbeat/lease/ACK/inventory writes; absence requires a complete ordered error-free versioned snapshot.
- Challenged garbage status framing, valid fault controls and undefined sensor half-pairs. Unsupported status does not assert readiness or hardware fault.
- Reproduced Unicode/newline Header failures; checked both fleet routes, ASCII compatibility, canonical UTF-8, conflicting/invalid cursor inputs, tenant/RBAC SQL predicates, sentinel projection and CORS metadata exposure.
- Challenged stale-fleet backlog/worker locking, full desired-state response sizes, interrupted/looped/wrong-owner/invalid/duplicate pages, false success and failed persistence. A partial page never becomes an authoritative smaller snapshot; old clients requiring paging are explicitly fenced.
- Rechecked current claim/idempotency/admission/reconnect fences, Windows service identity/status/RAW-versus-driver semantics, Odoo page generation/bindings, migration ordering, active-job retention, cleanup and secret/log boundaries. Existing substantive native/live regressions were retained and Windows execution is now a CI gate.

## Compatibility and remaining release gates

1. Run migration **0080 before the updated Gateway**. Upgrade Agents for ordered inventory and negotiated desired-state paging. Versionless legacy inventory is additive until a versioned writer is established, then rejected. Large legacy manager snapshots require upgrade; no truncated list is ever marked complete.
2. Capabilities collection reads are now paginated (100 default / 1000 max); traverse X-Next-Cursor. Fleet lists retain arrays/offset compatibility and add encoded UTF-8 keyset IDs. API docs explain both contracts.
3. Local Go/race/vet/staticcheck/gofmt, Windows spooler/USB/PDF tests, Rust/Tauri/installer, PostgreSQL migrations/integration/concurrency/EXPLAIN, and real Odoo 19 install/tests require runtimes absent locally. GitHub CI will be inspected after publication; **pending/canceled/unexecuted checks are not passes**.
4. Windows service-account versus interactive-user queue visibility, real device health/back-channel behavior, physical RAW/IPP/spooler/PDF output and crash/network/driver fault injection are **UNVERIFIED** without deployment hardware.
5. QWeb page dimensions/layout remain in the PDF, but Windows rendering fits the queue's configured printable area. It does **not** automatically select PDF custom paper/orientation/tray/duplex or reproduce a browser print dialog. Configure the driver and physically certify custom sizes, margins, Arabic shaping, fonts, rotation, labels/barcodes, POS and kitchen output as documented in `docs/PRINT_CERTIFICATION.md`.
6. Native desired-state traversal has explicit byte/time budgets; unusual configuration volumes require distributing work across Agents. Live load and disaster-recovery exercises remain unverified.
7. The previously reported Windows Gateway connection failure was not reproduced on the user's PC. Existing strict-probe diagnostics/localized-error repairs do not prove that connection fixed.

Risk: migration/Agent rollout and native printing paths require review and real gates. No main merge/deployment is part of this task. Physical production certification remains separate from completion of the source audit and PR workflow.

## Publication / Definition of Done

Task 2 and Task 3: complete with the explicit verification limits above.
Task 4: final report/commit/push/PR publication in progress.
Definition of Done: **NOT YET SATISFIED** until the repair branch and PR to main exist; CI/runtime results must be recorded accurately.
