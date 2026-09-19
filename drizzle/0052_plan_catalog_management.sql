-- Platform-managed plan catalog controls.
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "description" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "display_order" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "stripe_product_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "plans_stripe_product_id_unique"
  ON "plans" ("stripe_product_id")
  WHERE "stripe_product_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "plans_catalog_idx"
  ON "plans" ("is_active", "is_public", "display_order", "name");

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_display_order_check"
  CHECK ("display_order" >= 0);
