-- Keep legacy plan rows and historical Stripe bindings intact.
-- NULL means no explicitly configured public manual price yet.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "price_amount" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_price_amount_format_check"
  CHECK ("price_amount" IS NULL OR ("price_amount" ~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$'));
