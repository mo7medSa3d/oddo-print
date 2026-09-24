-- Preserve Stripe lifecycle semantics locally instead of collapsing
-- incomplete, unpaid, and paused into one state. This keeps access policy
-- and Stripe mutation routing deterministic.
ALTER TABLE "tenant_subscriptions"
  DROP CONSTRAINT IF EXISTS "tenant_subscriptions_status_check";
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "tenant_subscriptions_status_check"
  CHECK ("status" in ('trialing','active','past_due','incomplete','incomplete_expired','unpaid','paused','cancelled'));
