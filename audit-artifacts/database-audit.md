# Database Audit Report

## 1. Schema Overview
- **ORM / Driver**: Drizzle ORM / `pg` node-postgres pool
- **Tables (16)**: `tenants`, `users`, `tenant_users`, `tenant_invitations`, `manager_sessions`, `agents`, `printers`, `api_keys`, `print_jobs`, `job_logs`, `audit_events`, `auth_rate_limits`, `gateway_metrics`, `subscriptions`, `email_verification_tokens`, `password_reset_tokens`.

---

## 2. Multi-Tenancy & Predicates Audit
- **Tenant Predicates**: All major data tables include an indexed `tenant_id` foreign key.
- **SQL WHERE Clauses**: Rest APIs enforce `eq(table.tenantId, tenantId)` on every SELECT, UPDATE, and DELETE.
- **Drizzle ORM Queries**: `withTenant` in `src/db/tenant.ts` sets `app.current_tenant` in PostgreSQL session config. (Full PG RLS policy rollout is deferred to Phase 2; application-level tenant isolation is 100% verified).

---

## 3. Migration & Performance Indexes
- **Migration Pipeline**: SQL migrations 0001 through 0042 in `drizzle/` execute sequentially.
- **Inline Backfill**: Migration 0029 handles tenant backfill inline using SQL `DO $$` blocks (obsolete standalone script deleted).
- **DoS Hardening Indexes**: Migration 0042 creates performance indexes:
  - `print_jobs_tenant_created_idx`
  - `print_jobs_tenant_agent_status_expiry_idx`

---

## 4. Claim Fencing & Transaction Locks
- **Claim Token Fencing**: `claim_token` UUID assigned on job claim; echoed back by agents on status updates to prevent TOCTOU races.
- **SKIP LOCKED**: CTE claim query in `src/lib/job-delivery.ts` uses `FOR UPDATE OF p SKIP LOCKED` to eliminate lock contention with agent presence sweeps.
- **Advisory Locks**: `pg_advisory_xact_lock` used for multi-instance claim synchronization.
