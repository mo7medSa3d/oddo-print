# Independent code-first engineering verification - 8 October 2026

**Repository:** `mo7medSa3d/oddo-print`; baseline `main` commit `fa2c5ab021e6bea6ce0af8383d5f22b5207b7b3b`.
**Working branch:** `engineering/poll-claim-budget-20261008`; GitHub PR #127 (existing, reused).
**Scope:** actual source, new regressions, representative sensitive API/auth/DB/printing paths, build manifests, tests. All pre-existing audit and findings artifacts were excluded as evidence.
**Decision:** NOT CERTIFIED PRODUCTION READY. Source corrections are real, but comprehensive DB/runtime/Windows/physical verification is incomplete. A green static check cannot replace end-to-end measurements.

## Verified GitHub CI — PR #127, source commit 7c782b227bd8a16e48989feba4b0f1e9c166a7a3

- [CI run 37828492290](https://github.com/mo7medSa3d/oddo-print/actions/runs/37828492290): App/Gateway **success**, PostgreSQL16 migrations & integration **392 passing tests**, Vitest unit **929 passing / 6 skipped**, Python **235 passing**, Typecheck, ESLint and Next.js production build passed.
- The same CI run: Go Agent **success** with race-enabled tests and vet; Odoo19 Community addon **209 tests / 0 failures / 0 errors**.
- Docker run 37828492395, static security run 37828492429, security/resilience run 37828492311: **success**.
- Windows installer run 37828492253: **not yet verified as completed** at the time of this checkpoint. Re-check the workflow.
- Even all-green CI is **not physical Windows/printer or enterprise-scale E2E evidence**. Physical output, latency p95/p99 and recovery drills remain blocked/unverified.

## Real corrected defects

1. **P1 queue delivery correctness** (`src/app/api/agent/jobs/route.ts`): a poll claimed jobs before trimming the response to 64 MiB, creating unsent `DELIVERY_EVIDENCE_PENDING` claims and false unknown-print outcomes. Claim only the ordered SQL candidates within a conservative cumulative encoded-byte limit before the UPDATE, with no subsequent JS truncation. Regression: direct GET feedback loop + PG-backed `tests/ws-claim-delivery.test.ts` (latter awaits CI).
2. **P2 resource-capacity enforcement** (`src/lib/print-job-service.ts`): `pg_column_size` undercounted the logical print payload backlog when PostgreSQL TOAST compressed JSONB; changed to `octet_length(payload::text)`. Added native and PG integration regression, and registered PG test in canonical integration group.
3. **P2 maintenance recovery safety** (`src/lib/job-maintenance.ts`): positive fractional batch override could round down to zero and silently prevent cleanup/recovery; huge override could remove practical row-lock bound. Validate minimum 1 and clamp to 5000 with defaults retained. Added 4 direct-expression regression assertions.

## Phase-by-phase engineering evidence and boundaries

`PASS` is reserved for a demonstrated gate, not merely source inspection. `PARTIAL` means relevant files were inspected and some checks passed but the complete phase gate was not proven. `BLOCKED` indicates unprovided runtime/toolchain/hardware needed for meaningful verification.

| Phase | Domain | Status | Source/verification performed | Next non-optional gate |
|:---:|---|---|---|---|
| 00 | Baseline, manifests | PARTIAL | package.json, go.mod, Cargo manifest, Odoo addon, five Actions workflows; Node/Python baseline | Node 24, Go 1.26.8, Rust and PG full builds |
| 01 | Ownership and architecture | PARTIAL | Odoo print intent/router, Gateway admission/state, Agent executor sources read | Live cross-component ownership trace |
| 02 | Tenant isolation | PARTIAL | Agent/manager/Odoo auth, tenant-scoped job/printer DB predicates inspected | PostgreSQL negative tenant tests |
| 03 | Identity/session | PARTIAL | agent-auth, manager-auth, customer-auth, session-token paths inspected | Live expiration/revocation/multisession tests |
| 04 | RBAC | PARTIAL | authorization.ts and sensitive manager mutations sampled | Exhaustive negative coverage for 78 API routes |
| 05 | DB/migrations | PARTIAL | 81 migration files, 25 schema tables; PG16 CI migrations and 392 integration tests PASS | Legacy upgrade/rollback drill |
| 06 | API security | PARTIAL | 78 endpoint route files inventoried; pairing, print, jobs and sensitive mutations inspected | Full malicious-input/IDOR/abuse lab |
| 07 | Credentials | PARTIAL | Agent bearer auth and sealed credential/HTTPS configuration inspected | Rotation, revocation, and storage integration tests |
| 08 | Claim fencing/queue | PARTIAL | Real P1 fixed; native repro GREEN; PG regression authored | Execute new tests on actual PG16 |
| 09 | WS/delivery | PARTIAL | Claim/evidence/unknown-outcome safety contracts inspected | Multi-instance/reconnect/race live tests |
| 10 | Go agent | PARTIAL | 136 Go source files; Go CI race tests and vet PASS | Actual Windows service run and physical print |
| 11 | Agent latency | BLOCKED | Poll pacing/retry and receipt paths inspected | Real T0-T10 timings, p50/p95/p99 |
| 12 | Printer discovery | BLOCKED | WSD, SNMP, IPP, Spooler discovery implementations present | Real Windows/LAN discovery verification |
| 13 | Inventory | PARTIAL | Runtime printer/agent ownership routes sampled | Actual provisioning and inventory synchronization |
| 14 | Payload contract | PARTIAL | Strict 5 MiB canonical base64 checks, capability routing, Go/TS contract examined | Agent/device transport E2E for each protocol |
| 15 | Gateway test print | BLOCKED | Test-print route and validation path inspected | Real Gateway->Agent->printer output |
| 16 | Odoo integration | PARTIAL | Odoo19 Community live addon install + 209 tests passed in CI | Real Gateway↔Odoo↔Windows printer handshake |
| 17 | Odoo reports | BLOCKED | Report/print interception sources present | Full Odoo report, PDF attachment/email isolation |
| 18 | Odoo POS | BLOCKED | POS router, order/session modules present | POS printing/reprint/restaurant on Odoo19 |
| 19 | Windows printing | BLOCKED | Spooler, PDF/image, Win32 implementation present | Windows service and physical printer outcome |
| 20 | Print performance | BLOCKED | No measured physical T0-T10/p99 evidence | Cold/warm burst/reconnect stress benchmark |
| 21 | Observability | PARTIAL | Structured log, metrics and job timeline code reviewed | Operational correlated tracing across all hops |
| 22 | Entitlement/quota | PARTIAL | Tenant subscription checks in enqueue/claim; queue byte budget fixed | Concurrent quota contention under PG |
| 23 | Deployment models | PARTIAL | Deployment workflows and tenant/scoping configuration inspected | Real Pool/Bridge/Silo deployment/failover proof |
| 24 | Scale/noisy neighbor | PARTIAL | Compressed-size bypass fixed and regression added | Multi-tenant load/p95/p99 and capacity profile |
| 25 | Attack simulation | BLOCKED | Source-level auth boundaries reviewed | Actual adversarial API/network tests |
| 26 | Recovery/DR | PARTIAL | Zero/unbounded sweeper configuration fixed; native regressions pass | PG transaction interruption and restart/reconcile test |
| 27 | CI/build/release | PARTIAL | CI Gateway/PG16/Go/Odoo19 PASS; Docker and security PASS; 133 native Node green | Windows installer workflow completion and release deployment |
| 28 | Physical end to end | BLOCKED | Not physically tested; missing printer/Windows/Odoo lab locally | Evidence of real paper output, retries and status reconciliation |
| 29 | Certification | NOT READY | Cross-phase evidence matrix; do not infer readiness from test counts | Close required runtime/physical gates |

## Exact local commands / results

| Check | Result |
|---|---|
| `node --experimental-vm-modules --test tests/*.test.mjs` | 133 PASS / 0 FAIL |
| `python3 -m pytest -q tests/test_*.py` | 234 PASS / 1 ERROR: `rustc` binary unavailable |
| `python3 scripts/check-db-docs.py` | PASS: schema/migrations/database docs coherent (25 current tables, 81 SQL migrations) |
| `python3 scripts/check-odoo-translations.py` | PASS: 706 translation entries |
| `gofmt -l agent/...` | No format violations observed |
| TypeScript syntax parse | No parse errors in inspected TS/TSX sources; **not** full typecheck |
| Real DB integration | NOT RUN locally; no PG server/connection |
| Go 1.26.8/race | NOT RUN locally; host Go is 1.23.2 |
| Next.js production build/lint/typecheck | NOT RUN locally; required Node >=24; host Node is 22.16.0 with no complete deps |
| Tauri/Rust/Windows | NOT RUN locally; rustc and Windows environment absent |
| Odoo 19 runtime, printer hardware | NOT VERIFIED locally |

## Commercial readiness criteria

- **Correctness**: no known false-delivery claims left after source fix; however real PG execution and hardware outcomes are pending.
- **Security**: no existing authentication, tenant, claim fence or physical unknown-outcome guard deliberately weakened. This is not a penetration-test clearance.
- **Scalability**: per-agent byte limit is now logically correct, but no latency or 1k/10k-tenant benchmarks were obtained.
- **Deployment**: approval must wait for the actual target-environment release workflows and rollback drills, not mock/unit passes.

References: PostgreSQL 16 TOAST https://www.postgresql.org/docs/16/storage-toast.html and locking/CTE https://www.postgresql.org/docs/16/sql-select.html .