-- Keep the database default aligned with src/db/schema.ts.
-- current_period_start is required for every subscription and new rows
-- should receive the current time when callers do not supply an explicit
-- Stripe period start (for example during local/test provisioning).
ALTER TABLE "tenant_subscriptions"
  ALTER COLUMN "current_period_start" SET DEFAULT CURRENT_TIMESTAMP;
