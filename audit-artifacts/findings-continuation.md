# Findings Reconciliation & Continuation Matrix

| Finding ID | Original Severity | Current Severity | Category | Affected File(s) | Previous Status | Independent Status | Final Status | Verification Evidence / Rationale |
|------------|-------------------|------------------|----------|------------------|-----------------|--------------------|--------------|-----------------------------------|
| CONC-1 | P1 | P1 | Concurrency | `job-delivery.ts`, `agent/jobs/route.ts` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | `FOR UPDATE OF p SKIP LOCKED` prevents heartbeat agent row locks from blocking job claims |
| ARCH-2 | P1 | P1 | Tenant Isolation | `src/app/api/agent/jobs/route.ts` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | `AND a.tenant_id = p.tenant_id` and `pr.tenant_id` enforced in all 8 poll JOIN clauses |
| CI-002 | P1 | P1 | CI/CD | `Dockerfile` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | `tsconfig.json` included in runtime stage COPY step |
| SEC-1 | P2 | P2 | Security | `src/lib/manager-auth.ts` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | `compareStringsSafe` uses SHA-256 digest comparison before `timingSafeEqual` |
| SEC-2 / API-2 | P2 | P2 | Security | `src/server/trusted-proxy.ts` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | `safeEqual` digests inputs to SHA-256 to eliminate secret length oracle |
| CI-001 | P2 | P2 | CI/CD | `.github/workflows/ci.yml` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | `cancel-in-progress` set to `${{ github.ref != 'refs/heads/main' }}` |
| DOC-3 | P1 | P1 | Documentation | `DEPLOYMENT.md` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | Proxy header name updated to `X-Gateway-Proxy-Token` matching Caddyfile |
| DOC-1 | P2 | P2 | Documentation | `SECURITY.md` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | Updated password hashing section to specify Argon2id |
| PERF-5 | P2 | P3 | Performance | `Dockerfile` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | Replaced V8 node fetch with lightweight `wget --spider` |
| DOC-4 | P2 | P3 | Documentation | `.env.example` | FIXED | VERIFIED_FIXED | VERIFIED_FIXED | Added missing manager credentials, platform tenant ID, and stale threshold env vars |
| ARCH-1 | P1 | P1 | Tenant Isolation | `src/lib/job-fencing.ts`, `job-delivery.ts` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Added `tenantId` parameter & `eq(printJobs.tenantId, tenantId)` SQL predicate to `fencedJobWrite` & `fencedDeliveryWrite` |
| CONC-2 | P1 | P1 | Concurrency | `src/server/ws.ts` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Implemented `stopped` flag pattern in `attachAgentWSS` for listener startup/shutdown race |
| OPS-2 | P1 | P1 | Reliability | `src/app/api/live/route.ts`, `Dockerfile`, `docker-compose.yml` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Created `/api/live` endpoint for liveness probe; decoupled container restart from DB outage |
| OPS-5 | P2 | P2 | Audit | `src/app/actions.ts`, `src/app/api/...` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Replaced all `.catch(() => undefined)` swallowed audit logs with structured `logError` |
| OPS-1 | P3 | P3 | Observability | `server.ts`, `src/server/ws.ts`, `src/app/...` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Standardized unstructured `console.error`/`console.warn` calls to `logError`/`logWarn` |
| DOC-2 | P2 | P2 | Documentation | `API.md` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Documented `POST /api/print/jobs/batch-status` endpoint schema and authorization |
| DB-002 | P3 | P3 | Schema | `scripts/backfill_tenants.ts` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Deleted redundant `backfill_tenants.ts` script; migration 0029 handles inline |
| DEP-01 | P3 | P3 | Dependencies | `package.json` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Upgraded `@types/node` to 24 and fixed underlying TS type mismatches |
| AGENT-2 | P2 | P2 | Go Agent | `agent/internal/printer/spooler_windows.go` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Added `defer runtime.KeepAlive` for docName and dataType UTF-16 pointers |
| PERF-2 | P1 | P1 | Go Agent | `agent/internal/queue/cleanup.go`, `agent/internal/agent/agent.go` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Added daily background retention pruning ticker for Go agent SQLite terminal jobs |
| AGENT-3 | P2 | P2 | Go Agent | `agent/internal/agent/agent.go`, `pairing.go`, `dispatch_test.go` | OPEN | VERIFIED_FIXED | VERIFIED_FIXED | Increased `maxPendingJobsPerPrinter` ceiling to 128; enforced HTTP opt-in in `validateServerURL` |
| UI-2 | P2 | P2 | Frontend | `src/app/verify-email/page.tsx` | OPEN | FALSE_POSITIVE | FALSE_POSITIVE | Page already handles `email` query param correctly (sets state to `pending`) |
| ODOO-01 | P1 | P1 | Odoo Addon | `odoo_addons/print_gateway/models/print_intent.py` | OPEN | FALSE_POSITIVE | FALSE_POSITIVE | Code at lines 183-184 already rebinds `intent` and `record` with `.with_env(new_env)` |
| ODOO-02 | P2 | P2 | Odoo Addon | `odoo_addons/print_gateway/models/gateway_config.py` | OPEN | FALSE_POSITIVE | FALSE_POSITIVE | Exception handlers return `ir.actions.client` dicts without re-raising; write is not rolled back |
| CI-003 | P2 | P3 | Security | `Caddyfile` | OPEN | ACCEPTED_RISK | ACCEPTED_RISK | Caddy is configured as edge reverse proxy; overwriting `X-Forwarded-For` is intentional |
| PERF-1 | P0 | P2 | Performance | `src/lib/ws-rate-limit.ts` | OPEN | ACCEPTED_RISK | ACCEPTED_RISK | DB rate limiting prevents multi-instance bypass; in-memory `localLockedUntil` caches lockouts |
| PERF-3 | P1 | P2 | Performance | `src/lib/metrics.ts` | OPEN | ACCEPTED_RISK | ACCEPTED_RISK | `renderFleetGauges` runs on demand when Prometheus scrapes `/api/metrics`, not on hot path |
| SEC-3 | P2 | P3 | Security | `src/lib/manager-auth.ts` | OPEN | ACCEPTED_RISK | ACCEPTED_RISK | Argon2id execution time delta vs missing user is accepted trade-off to prevent CPU exhaustion DoS |
| DB-001 | P1 | P1 | Security | `src/db/tenant.ts` | OPEN | VERIFIED_OPEN | OPEN | RLS session variables set; full PG RLS policies deferred to DB Phase 2 rollout |
| DB-003 | P3 | P3 | Schema | `src/db/schema.ts` | OPEN | VERIFIED_OPEN | OPEN | `tenantDomains.isPrimary` partial unique index recommended for next migration |
| AGENT-1 | P1 | P1 | Go Agent | `agent/internal/agent/agent.go` | OPEN | VERIFIED_OPEN | OPEN | `wg.Add(1)` inside `inFlightMu` synchronized with `beginShutdown`; benign shutdown race |
| PERF-4 | P1 | P2 | Performance | `src/lib/metrics.ts` | OPEN | VERIFIED_OPEN | OPEN | `incrementMetric` DB write is non-blocking (`catch` ignored) and buffered by Postgres WAL |
| PERF-6 | P2 | P2 | Performance | `src/app/api/print/jobs/route.ts` | OPEN | VERIFIED_OPEN | OPEN | `MAX_BODY` is capped at 8MB by body guard and Caddy; streaming deferred to multi-part API |
| OPS-3 | P2 | P3 | Observability | `src/lib/metrics.ts` | OPEN | VERIFIED_OPEN | OPEN | Local counters serve as fallback during DB connection loss; synced on reconnect |
| OPS-4 | P3 | P3 | Observability | `src/lib/log.ts` | OPEN | VERIFIED_OPEN | OPEN | `tenantId` log context added where available; request ID provides primary correlation |
| UI-1 | P2 | P3 | Desktop | `src/desktop/pages/Jobs.tsx` | OPEN | VERIFIED_OPEN | OPEN | Desktop UI manually refreshable; WebSocket event push for desktop planned |
| UI-3 | P3 | P4 | Frontend | `src/components/` | OPEN | VERIFIED_OPEN | OPEN | Minor UI form element accessibility label enhancements |
