-- Prevent tenant trial reset on repeated onboarding attempts and preserve the
-- fact that a workspace has already consumed its initial trial entitlement.
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "trial_started_at" timestamp;
