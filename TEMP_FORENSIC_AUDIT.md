# TEMP FORENSIC AUDIT — Full-Repository Coverage Ledger

Static/source-only audit. No tests, builds, compilers, linters, servers, Docker, installers,
migrations, or runtime verification are executed.

Repository: print gateway (Next.js/TypeScript gateway + Go agent + Tauri desktop + Odoo addon + PostgreSQL)

## Conventions

- Status: `TODO` → `REVIEWED` (file actually read and analyzed) → `FIXED` (defect repaired)
- Findings recorded in Phase 4 section with classification.

## Phase 1 — Coverage ledger

### A. Root configuration / build / CI / deploy

| File | Status |
|---|---|
| .dockerignore | REVIEWED |
| .env.example | TODO |
| .gitignore | REVIEWED |
| .npmrc | REVIEWED |
| .nvmrc | REVIEWED |
| Caddyfile | REVIEWED |
| Dockerfile | TODO |
| docker-compose.yml | TODO |
| drizzle.config.ts | REVIEWED |
| eslint.config.mjs | REVIEWED |
| next-env.d.ts | REVIEWED |
| next.config.ts | REVIEWED |
| package.json | REVIEWED |
| postcss.config.mjs | REVIEWED |
| proxy.ts | REVIEWED |
| server.ts | REVIEWED |
| tsconfig.json | REVIEWED |
| vite.desktop.config.mts | REVIEWED |
| vitest.config.mts | TODO |
| vitest.integration.config.mts | TODO |
| vitest.test-groups.mts | TODO |
| vitest.unit.config.mts | TODO |
| .github/dependabot.yml | TODO |
| .github/workflows/build-windows.yml | TODO |
| .github/workflows/ci.yml | TODO |
| .github/workflows/docker.yml | TODO |
| .github/workflows/security-supply-chain.yml | TODO |
| .github/workflows/static-security.yml | TODO |

### B. scripts/

| File | Status |
|---|---|
| scripts/bootstrap-platform-owner.ts | TODO |
| scripts/build-windows-installer.ps1 | TODO |
| scripts/check-db-docs.py | TODO |
| scripts/check-i18n.ts | TODO |
| scripts/check-odoo-translations.py | TODO |
| scripts/count-ignored-results.sh | TODO |
| scripts/db-generate.ts | TODO |
| scripts/db-migrate.ts | TODO |
| scripts/generate-icons.mjs | TODO |
| scripts/pg-concurrent-claim.sh | TODO |
| scripts/pg-notify-failure-injection.ts | TODO |
| scripts/provision-plans.ts | TODO |
| scripts/setup-tauri-linux.sh | TODO |
| scripts/smoke-test-windows.ps1 | TODO |

### C. src/server, src/lib, src/shared, src/db

| File | Status |
|---|---|
| src/server/api-defaults.ts | REVIEWED |
| src/server/content-security-policy.ts | REVIEWED |
| src/server/correlation.ts | REVIEWED |
| src/server/cors.ts | REVIEWED |
| src/server/request-guard.ts | REVIEWED |
| src/server/trusted-proxy.ts | REVIEWED |
| src/server/ws.ts | REVIEWED |
| src/shared/job-vocabulary.ts | REVIEWED |
| src/db/client.ts | REVIEWED |
| src/db/index.ts | REVIEWED |
| src/db/schema.ts | REVIEWED |
| src/lib/action-error.ts | REVIEWED |
| src/lib/agent-auth.ts | REVIEWED |
| src/lib/agent-availability.ts | REVIEWED |
| src/lib/agent-control.ts | REVIEWED |
| src/lib/agent-health.ts | REVIEWED |
| src/lib/agent-lifecycle.ts | REVIEWED |
| src/lib/agent-presence-maintenance.ts | REVIEWED |
| src/lib/api-error-keys.ts | REVIEWED |
| src/lib/audit.ts | REVIEWED |
| src/lib/authorization.ts | REVIEWED |
| src/lib/auth-rate-limit.ts | REVIEWED |
| src/lib/billing-operation.ts | REVIEWED |
| src/lib/cache.ts | REVIEWED |
| src/lib/canonicalize.ts | REVIEWED |
| src/lib/circuit-breaker.ts | REVIEWED |
| src/lib/clipboard.ts | REVIEWED |
| src/lib/console-auth.ts | REVIEWED |
| src/lib/customer-auth.ts | REVIEWED |
| src/lib/database-clock.ts | REVIEWED |
| src/lib/discovery.ts | REVIEWED |
| src/lib/email.ts | REVIEWED |
| src/lib/entitlements.ts | REVIEWED |
| src/lib/idempotency.ts | REVIEWED |
| src/lib/job-delivery.ts | REVIEWED |
| src/lib/job-fencing.ts | REVIEWED |
| src/lib/job-maintenance.ts | REVIEWED |
| src/lib/job-status.ts | REVIEWED |
| src/lib/job-timeline.ts | REVIEWED |
| src/lib/lifecycle-labels.ts | REVIEWED |
| src/lib/lifecycle.ts | REVIEWED |
| src/lib/limit-signal.ts | REVIEWED |
| src/lib/log.ts | REVIEWED |
| src/lib/manager-auth.ts | REVIEWED |
| src/lib/metrics.ts | REVIEWED |
| src/lib/nanoid.ts | REVIEWED |
| src/lib/nav.ts | REVIEWED |
| src/lib/network-address.ts | REVIEWED |
| src/lib/odoo-auth.ts | REVIEWED |
| src/lib/password.ts | REVIEWED |
| src/lib/payload.ts | REVIEWED |
| src/lib/platform-auth.ts | REVIEWED |
| src/lib/printer-capability.ts | REVIEWED |
| src/lib/printer-health.ts | REVIEWED |
| src/lib/printer-model.ts | REVIEWED |
| src/lib/printer-virtual.ts | REVIEWED |
| src/lib/print-job-service.ts | REVIEWED |
| src/lib/request-limits.ts | REVIEWED |
| src/lib/routing.ts | REVIEWED |
| src/lib/runtime-secret.ts | REVIEWED |
| src/lib/session-config.ts | REVIEWED |
| src/lib/session-tokens.ts | FIXED |
| src/lib/stale-threshold.ts | REVIEWED |
| src/lib/stripe.ts | REVIEWED |
| src/lib/system-health.ts | REVIEWED |
| src/lib/tenant-guard.ts | REVIEWED |
| src/lib/tenant-lifecycle.ts | REVIEWED |
| src/lib/trust-proxy-config.ts | REVIEWED |
| src/lib/utils.ts | REVIEWED |
| src/lib/worker-schema.ts | REVIEWED |
| src/lib/ws-rate-limit.ts | REVIEWED |

### D. src/app/api routes (all)

| File | Status |
|---|---|
| all route.ts under src/app/api | TODO |

### E. src/app pages, src/components, src/i18n, src/desktop

| File | Status |
|---|---|
| all page/client/tsx under src/app | TODO |
| src/components/*.tsx | TODO |
| src/i18n/* | TODO |
| src/desktop/** | TODO |

### F. src-tauri (Rust)

| File | Status |
|---|---|
| src-tauri/src/*.rs, Cargo.toml, tauri.conf.json, capabilities, build.rs, installer_hooks.nsh | TODO |

### G. agent (Go)

| File | Status |
|---|---|
| agent/** (all .go, config, Makefile, go.mod) | TODO |

### H. odoo_addons (Python/XML/CSV)

| File | Status |
|---|---|
| odoo_addons/print_gateway/** | TODO |

### I. drizzle migrations

| File | Status |
|---|---|
| drizzle/*.sql, drizzle/meta/* | TODO |

### J. tests/

| File | Status |
|---|---|
| tests/** | TODO |

### K. contracts, docs, top-level markdown

| File | Status |
|---|---|
| contracts/*, docs/*, *.md at root, archive/* | TODO |

(ledger expanded during audit)

---

## Phase 4 — Findings (classification required for every candidate)

Fields: ID · location (file:line) · code path · components · evidence · severity ·
classification (CONFIRMED / SAFE / INTENTIONAL / SPECULATIVE / RUNTIME-ONLY) ·
affected contract or invariant · fix (if CONFIRMED).

### F-001 — Lock-order inversion between refresh rotation and session-family revoke

- **Location:** `src/lib/session-tokens.ts:770-783` (`revokeRefreshTokenFamily`) vs `src/lib/session-tokens.ts:540-575` (`rotateRefreshToken`).
- **Code path:** logout (`src/app/api/auth/logout/route.ts`, `src/app/api/auth/manager/logout/route.ts`,
  `src/app/api/platform/auth/logout/route.ts`) → `revokeRefreshTokenFamily` → `SELECT … FOR UPDATE` on the
  `refresh_tokens` row **first**, then `revokeSessionFamilyInTransaction` → `pg_advisory_xact_lock(hashtextextended(family))`;
  concurrent refresh (`src/app/api/auth/refresh/route.ts`, `…/manager/refresh/route.ts`, `…/platform/auth/refresh/route.ts`)
  → `rotateRefreshToken` → advisory lock **first**, then `SELECT … FOR UPDATE` on the same row.
- **Components:** Gateway (Next.js server routes) ↔ PostgreSQL (row lock + session advisory lock).
- **Evidence:** both transactions take the same two locks (row of token `R`, family advisory `F`) in opposite
  order; a logout and a refresh of the same refresh token are concurrent-reachable → PostgreSQL deadlock
  (`40P01`) aborts one of the two with an error response.
- **Severity:** medium (availability/error on concurrent logout+refresh; no data corruption).
- **Classification:** **CONFIRMED** (proved from source; no runtime needed).
- **Affected contract/invariant:** logout and refresh of the same session must serialize on the family lock
  without deadlocking (single documented lock order: advisory family lock → row locks).
- **Fix:** drop the pre-advisory `FOR UPDATE` in `revokeRefreshTokenFamily` (family membership of a row is
  immutable; the family advisory lock — already taken by `revokeSessionFamilyInTransaction` — is the
  serialization point, and its `UPDATE … WHERE family_id = … AND revoked_at IS NULL` takes the row locks
  under the advisory lock). Restores the documented order everywhere.
- **Status:** FIXED in `src/lib/session-tokens.ts` (lookup now unlocked; family advisory lock taken before
  any row lock; callers ignore the returned boolean, so no contract change).

(ledger expanded during audit)
