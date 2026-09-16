# Regression Results Log

## 1. Regression Testing Methodology
Every fix applied during the multi-pass audit and continuation was subjected to:
1. Direct targeted unit tests covering the specific defect scenario.
2. Second-order side-effect analysis (inspecting callers, dependent services, and SQL queries).
3. Full subsystem test suite execution (`vitest`, `go test -race`, `tsc`, `eslint`).

---

## 2. Verified Repairs & Regression Validation

| Finding ID | Subsystem | Description | Fix Applied | Regression Validation Result |
|------------|-----------|-------------|-------------|------------------------------|
| `CONC-1` | Concurrency | Heartbeat vs job claim lock race | `FOR UPDATE OF p SKIP LOCKED` in `job-delivery.ts` | **PASS** — Agent heartbeats do not block job claims |
| `ARCH-2` | Multi-Tenancy | Missing `tenant_id` in CTE JOINs | Added `a.tenant_id = p.tenant_id` to 8 JOIN clauses | **PASS** — Poll path queries strictly isolate tenant rows |
| `ARCH-1` | Execution Fencing | Missing `tenantId` in job fencing | Added `tenantId` parameter & SQL predicate to `fencedJobWrite` | **PASS** — Cross-tenant claim updates fail closed |
| `CONC-2` | Concurrency | PG listener connection leak | Implemented `stopped` flag pattern in `attachAgentWSS` | **PASS** — Listeners clean up on async shutdown |
| `OPS-2` | Reliability | DB outage container restart risk | Created `/api/live` endpoint (DB-decoupled liveness) | **PASS** — Container liveness probe succeeds without DB |
| `OPS-5` | Audit Logging | Swallowed audit write failures | Replaced `.catch(() => undefined)` with `logError` | **PASS** — Audit failures logged with diagnostic detail |
| `OPS-1` | Observability | Raw console logging | Replaced `console.error`/`warn` with `logError`/`logWarn` | **PASS** — Logs emitted in structured JSON format |
| `SEC-1` | Security | Manager auth timing side-channel | Fixed-length SHA-256 digest + `timingSafeEqual` | **PASS** — Auth comparison is constant-time |
| `SEC-2 / API-2` | Security | Proxy secret timing side-channel | Fixed-length SHA-256 digest + `timingSafeEqual` | **PASS** — Proxy token comparison is constant-time |
| `AGENT-2` | Go Agent | Windows spooler pointer GC risk | Added `defer runtime.KeepAlive` for UTF-16 pointers | **PASS** — String pointers stay pinned during spooler syscall |
| `PERF-2` | Go Agent | SQLite terminal job queue growth | Added daily background retention ticker (`CleanupTerminal`) | **PASS** — Terminal jobs older than 7d auto-pruned |
| `AGENT-3` | Go Agent | Printer queue lock scope | Printer lock acquired at physical print boundary | **PASS** — Same-printer status reports execute concurrently |
