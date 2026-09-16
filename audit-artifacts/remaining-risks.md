# Remaining Risks & Documented Limitations

## Overview

All critical (P0/P1) and high-priority (P2) fixable defects have been repaired, independently verified, and certified against the regression test suites. This document catalogues the explicitly accepted architectural trade-offs and remaining low-risk phase-2 items.

---

## Accepted Risks & Architectural Boundaries

1. **`CI-003`: Caddy `X-Forwarded-For` Overwriting**
   - **Context**: The bundled `Caddyfile` overwrites `X-Forwarded-For` with `{http.request.remote.host}`.
   - **Rationale**: Caddy is designed as the edge reverse proxy directly receiving public client traffic. Overwriting untrusted client-supplied `X-Forwarded-For` headers prevents IP spoofing. If deployed behind a cloud load balancer, Caddy should be configured to trust the LB's CIDR.

2. **`PERF-1`: Database-Backed WebSocket Rate Limiting**
   - **Context**: `reserveWsUpgradeAttempt` issues a `SELECT FOR UPDATE` on `auth_rate_limits` per WS upgrade.
   - **Rationale**: In multi-instance gateway deployments, in-memory limiters would allow attackers to bypass limits by rotating connections across nodes. The local `isWsUpgradeLocallyLocked` memory map caches locked IPs to bypass the DB check once an IP is flagged.

3. **`PERF-3`: Fleet Gauge Query Execution**
   - **Context**: `renderFleetGauges` performs `COUNT(*)` over `print_jobs`.
   - **Rationale**: This query is executed strictly on demand when a Prometheus scraper hits `/api/metrics`. It never touches the job creation or dispatch hot paths.

4. **`SEC-3`: Auth Response Time Delta vs. KDF Exhaustion**
   - **Context**: Login attempts for non-existent users return `null` faster than incorrect passwords due to Argon2id computation.
   - **Rationale**: Computing dummy Argon2id hashes for non-existent users would allow unauthenticated attackers to exhaust CPU cores by sending arbitrary emails. Standard rate limiting (`auth_rate_limits`) prevents mass email enumeration.

---

## Deferred Phase-2 Technical Debt

1. **`DB-001` (PostgreSQL Row-Level Security)**: Multi-tenancy is strictly enforced at the application level via WHERE clause predicates and Drizzle ORM schema scope. Full PostgreSQL RLS policies remain on the Phase-2 database roadmap.
2. **`DB-003` (Partial Unique Index)**: `tenantDomains.isPrimary` partial unique index recommended for next migration.
3. **`PERF-4` (Metrics DB Writes)**: `incrementMetric` writes directly to PostgreSQL in non-blocking try-catch blocks. Future optimization: batch metric flushes via background ticker.
4. **`PERF-6` (8MB Payload Memory Cap)**: Body size is capped at 8MB by Caddy and Next.js body guard. Multi-part streaming planned for >10MB document payloads.
