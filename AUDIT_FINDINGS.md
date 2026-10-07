# Gateway connection findings — 2026-10-07

| ID | Severity | Evidence | Repair | Status |
| --- | --- | --- | --- | --- |
| GW01 | P2 | Settings/Agents call friendlyGatewayError on already localized state; the mapper falls back to generic copy. | Render localized state once; normalize failures in the App shell. | Fixed; regression verified |
| GW02 | P2 | App calls errMsg before mapping GatewayApiError, losing its HTTP status when the server message is a machine code. | Map the original failure; prioritize structured status. | Fixed; en/ar regression verified |
| GW03 | P2 | probe_gateway_health has no start/outcome/error logging; reqwest Display hides nested connection causes. The supplied Manager log contains no connection-check outcome. | Add bounded native diagnostics with elapsed time/status/sanitized request ID and URL-free transport cause chains. | Implemented; contract verified; Rust build pending CI |

The original Windows connectivity failure remains unconfirmed. The live probe and health endpoints returned 200 during investigation. These repairs expose the actual failure and correct its presentation; they do not establish that the connection itself is repaired on the user's PC. The strict public identity probe, TLS verification, timeouts, credential isolation and configuration-save rules are preserved.

## Complete platform audit — new confirmed findings

### R01 — P2 — ESC/POS printer health

- Location: `agent/internal/printer/health.go`, QueryHealthStatus invalid-framing branches.
- Problem/root cause: fault bits are interpreted before validating fixed protocol framing. Garbage or echoed bytes with arbitrary bits become asserted offline/cover-open/paper-out status.
- Affected flow/impact: normal ESC/POS preflight and heartbeat Status may reject a usable printer based on a response that is not a valid status frame.
- Fix strategy: reject every invalid frame as status-unsupported; keep valid fault-frame behavior; regress all three inquiries with invalid fault-looking bytes.
- Regression/verification: invalid-frame and valid-fault Go cases added; existing TCP preflight case corrected. Go toolchain absent locally, execution BLOCKED pending CI.
- Status: FIXED; Go runtime confirmation pending CI.

### R02 — P1 — inventory stale snapshot replay

- Location: `src/app/api/agent/heartbeat/route.ts` page-1/final snapshot logic; `agent/internal/agent/heartbeat_pagination.go`; agents snapshot schema.
- Problem/root cause: random IDs fence pages inside a snapshot but do not order snapshots. Page 1 unconditionally supersedes current state; completed snapshot identity is cleared. Old page-1/full-snapshot requests can mutate a newer inventory and authorize destructive absence.
- Affected flow/impact: delayed/replayed heartbeat, reconnect, overlapping sessions; healthy printers disappear or restore outdated destinations/status.
- Fix strategy: monotonic int64 version serialized as decimal string, durable database high-water mark, transaction-locked validation before writes, exact version on continuations, Agent catch-up after a rejected old process clock, additive-only legacy behavior.
- Regression/verification: 18 executable policy/actual-route cases PASS; typecheck PASS. PostgreSQL integration and Go concurrency/clock rollback/restart cases added; live execution BLOCKED locally by missing runtimes.
- Status: FIXED; live PostgreSQL/Go confirmation pending CI.

### R03 — P2 — capability collection cardinality

- Location: `src/lib/printer-health.ts:getAllPrintersCapabilityMatrix`, `src/app/api/printers/capabilities/route.ts`.
- Problem/root cause: a tenant-wide query without LIMIT projects full config/capabilities and human-readable diagnostics for every printer. A time deadline is not a response/memory bound.
- Affected flow/impact: authenticated fleet capability reads have O(fleet) database/network/memory work; no traversal contract for large fleets.
- Fix strategy: bounded deterministic keyset pagination before projection, preserve array response, expose next-page headers; keep direct printerId lookup.
- Regression/verification: 15 executable query/route cases PASS; tenant/cursor predicates and pre-projection limits checked.
- Status: FIXED.

### R04 — P2 — offline regression coverage drift

- Location: `.github/workflows/ci.yml` offline Node step; `tests/dashboard-fleet-pagination.contract.test.mjs`.
- Problem/root cause: CI's audit-only filename glob omits native regression suites for sessions, inventory/status, pagination, UI and retention. The full 101-case suite exposes a stale throwing-API assertion after getDashboardStateResult replaced the client call.
- Affected flow/impact: previously added regressions can rot without CI detecting it.
- Fix strategy: run every native `.test.mjs` suite with the required VM flag; update the changed client contract while retaining pagination assertions.
- Regression/verification: complete native suite 101 PASS, 0 FAIL, 0 SKIP, using the same full glob now enforced by CI.
- Status: FIXED.

### R05 — P2 — stale-Agent sweep cardinality

- Location: `src/lib/agent-presence-maintenance.ts:sweepStaleAgentPresence`; server housekeeping timer.
- Problem/root cause: a global UPDATE modifies and returns every stale online Agent in one statement, unlike the bounded job sweep. Concurrent Gateway instances contend over the same backlog.
- Impact: a fleet-wide outage/reconnect can hold many row locks and materialize the complete stale fleet every tick. Request-time availability is already derived independently; persistence may safely converge in bounded batches.
- Fix: ordered, bounded candidate CTE with FOR UPDATE SKIP LOCKED, a validated/capped optional sweep limit, and retained lifecycle/freshness predicates.
- Regression/verification: 9 SQL-query/parameter/error cases PASS; combined affected regression suites 54 PASS. Live PostgreSQL contention unverified locally.
- Status: FIXED; runtime limitations above.

### R06 — P2 — native Windows Agent regressions omitted from CI

- Location: `.github/workflows/build-windows.yml`; Windows-tagged spooler/USB/PDF tests.
- Problem/root cause: Linux CI runs Go tests and cross-target staticcheck; the Windows workflow only builds Go binaries. Windows-tagged tests never execute.
- Impact: partial spooler writes, bounded preflight, SetupAPI parsing and the embedded PDF renderer can regress without the installer gate detecting them.
- Fix: run Go module verification, native vet and the full native Go test suite in the existing Windows runner before packaging. Linux race coverage remains in CI.
- Regression/verification: existing substantive Windows tests inspected; native execution blocked locally.
- Status: FIXED; runtime limitations above.
