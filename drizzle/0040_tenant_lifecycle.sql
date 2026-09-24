-- Tenant lifecycle: explicit operational state for suspension and soft-deletion.
-- Existing rows default to 'active' (the only pre-existing state); no backfill needed.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "lifecycle" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "suspended_at" timestamp,
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp,
  ADD COLUMN IF NOT EXISTS "lifecycle_reason" text;
--> statement-breakpoint
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_lifecycle_check" CHECK (lifecycle IN ('active', 'suspended', 'deleted'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_lifecycle_idx" ON "tenants" USING btree ("lifecycle");
