-- Replicate the Odoo Gateway Configuration activation state for Gateway UI.
-- This is intentionally separate from tenant lifecycle so disabling Odoo printing
-- never suspends the tenant and therefore never prevents a later re-enable.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "odoo_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "odoo_enabled_revision" integer NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "odoo_enabled_updated_at" timestamp;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_odoo_enabled_revision_check"
  CHECK ("odoo_enabled_revision" >= -1);