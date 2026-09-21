-- Move Odoo activation state from the tenant boundary to the Odoo integration API-key boundary.
-- Existing tenant-wide state is copied to every key in that tenant so the migration
-- preserves current runtime behavior before future toggles become isolated per key.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "odoo_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "odoo_enabled_revision" integer NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "odoo_enabled_updated_at" timestamp;

UPDATE "api_keys" AS k
SET
  "odoo_enabled" = COALESCE(t."odoo_enabled", false),
  "odoo_enabled_revision" = COALESCE(t."odoo_enabled_revision", -1),
  "odoo_enabled_updated_at" = t."odoo_enabled_updated_at"
FROM "tenants" AS t
WHERE t."id" = k."tenant_id";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_keys_odoo_enabled_revision_check'
  ) THEN
    ALTER TABLE "api_keys"
      ADD CONSTRAINT "api_keys_odoo_enabled_revision_check"
      CHECK ("odoo_enabled_revision" >= -1);
  END IF;
END $$;

ALTER TABLE "tenants"
  DROP CONSTRAINT IF EXISTS "tenants_odoo_enabled_revision_check";

ALTER TABLE "tenants"
  DROP COLUMN IF EXISTS "odoo_enabled_revision",
  DROP COLUMN IF EXISTS "odoo_enabled_updated_at",
  DROP COLUMN IF EXISTS "odoo_enabled";
