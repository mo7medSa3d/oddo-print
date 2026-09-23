-- Durable print-credit quota state.
-- One admitted print job consumes one print credit for the tenant's current
-- Stripe billing period. Retries that reuse an existing idempotency key do not
-- create another job and therefore do not consume another credit.
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "current_period_start" timestamp;

UPDATE "tenant_subscriptions"
SET "current_period_start" = COALESCE("current_period_start", CURRENT_TIMESTAMP)
WHERE "current_period_start" IS NULL;

ALTER TABLE "tenant_subscriptions"
  ALTER COLUMN "current_period_start" SET NOT NULL;

-- Existing plans pre-date print metering. Preserve their current behavior by
-- explicitly making the new commercial entitlement unlimited; Platform Admin
-- can later set a finite value such as 20.
UPDATE "plans"
SET "entitlements" = "entitlements" || '{"max_prints_per_period":"unlimited"}'::jsonb
WHERE NOT ("entitlements" ? 'max_prints_per_period');

CREATE TABLE IF NOT EXISTS "print_usage_periods" (
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "period_start" timestamp NOT NULL,
  "period_end" timestamp,
  "used_prints" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "print_usage_periods_pk" PRIMARY KEY ("tenant_id", "period_start"),
  CONSTRAINT "print_usage_periods_used_check" CHECK ("used_prints" >= 0),
  CONSTRAINT "print_usage_periods_period_check" CHECK ("period_end" IS NULL OR "period_end" > "period_start")
);

CREATE INDEX IF NOT EXISTS "print_usage_periods_tenant_period_end_idx"
  ON "print_usage_periods" ("tenant_id", "period_end");