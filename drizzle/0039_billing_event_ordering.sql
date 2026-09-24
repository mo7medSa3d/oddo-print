-- Guard local subscription state against out-of-order Stripe webhook delivery.
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "stripe_last_event_created_at" timestamp;
