-- Fail closed when a Stripe subscription Price is not mapped to a local plan.
-- Keep the last known plan identity for auditability, but block runtime
-- entitlements until the billing catalog is repaired.
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "entitlement_blocked" boolean NOT NULL DEFAULT false;

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "entitlement_blocked_reason" text;
