-- Migration 0045: Make audit_events.tenant_id nullable for platform-scoped events.
--
-- Platform Owner actions (bootstrap, login, logout) are global and have no
-- tenant. Previously these wrote tenant_id = 'platform' which violates the
-- FK to tenants.id. The correct model:
--
--   tenant-scoped event  → tenant_id = a real tenant ID
--   platform-scoped event → tenant_id IS NULL, actor_type = 'platform'
--
-- Step 1: Drop the NOT NULL constraint on tenant_id.
ALTER TABLE "audit_events" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- Step 2: Fix any existing rows that used the bogus 'platform' sentinel.
UPDATE "audit_events" SET "tenant_id" = NULL WHERE "tenant_id" = 'platform';

-- Step 3: Add a CHECK constraint enforcing scope rules:
--   • Non-platform actors MUST have a tenant_id (tenant-scoped only).
--   • Platform actors MAY have tenant_id (tenant action) or NULL (global action).
--   This means: tenant_id IS NOT NULL OR actor_type = 'platform'
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check"
  CHECK (tenant_id IS NOT NULL OR actor_type = 'platform') NOT VALID;

-- Validate separately so existing data is checked without holding an ACCESS EXCLUSIVE lock.
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_scope_check";
