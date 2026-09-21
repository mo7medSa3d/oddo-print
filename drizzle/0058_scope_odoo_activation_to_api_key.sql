-- Move Odoo activation state from the tenant boundary to the Odoo integration API-key boundary.
-- Existing tenant-wide state is copied to every key in that tenant so the migration
-- preserves current runtime behavior before future toggles become isolated per key.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "odoo_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "odoo_enabled_revision" integer NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "odoo_enabled_updated_at" timestamp;

-- Preserve the old tenant-wide state without enabling every historical/rotated key.
-- Only the most recently used active Odoo key per tenant inherits the state;
-- all other keys start disabled and must be explicitly synchronized by Odoo.
WITH ranked AS (
  SELECT
    k.id,
    t.odoo_enabled,
    t.odoo_enabled_revision,
    t.odoo_enabled_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY k.tenant_id
      ORDER BY (k.revoked_at IS NULL) DESC, k.last_used_at DESC NULLS LAST, k.created_at DESC, k.id DESC
    ) AS rn
  FROM api_keys k
  JOIN tenants t ON t.id = k.tenant_id
)
UPDATE api_keys AS k
SET
  "odoo_enabled" = CASE WHEN ranked.rn = 1 THEN COALESCE(ranked.odoo_enabled, false) ELSE false END,
  "odoo_enabled_revision" = CASE WHEN ranked.rn = 1 THEN COALESCE(ranked.odoo_enabled_revision, -1) ELSE -1 END,
  "odoo_enabled_updated_at" = CASE WHEN ranked.rn = 1 THEN ranked.odoo_enabled_updated_at ELSE NULL END
FROM ranked
WHERE ranked.id = k.id;

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
