ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "stripe_price_id" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "currency" text;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "interval" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plans_stripe_price_id_unique" ON "plans" ("stripe_price_id") WHERE "stripe_price_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_subscriptions_stripe_customer_id_unique" ON "tenant_subscriptions" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_subscriptions_stripe_subscription_id_unique" ON "tenant_subscriptions" ("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verification_tokens_user_idx" ON "email_verification_tokens" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verification_tokens_expires_idx" ON "email_verification_tokens" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_idx" ON "password_reset_tokens" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_expires_idx" ON "password_reset_tokens" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "inviter_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp NOT NULL,
  "accepted_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_invitations_role_check" CHECK (role IN ('admin','operator','viewer','integration_admin','billing_admin'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invitations_tenant_idx" ON "tenant_invitations" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invitations_email_idx" ON "tenant_invitations" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invitations_expires_idx" ON "tenant_invitations" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" text REFERENCES "tenants"("id"),
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "processed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_tenant_idx" ON "billing_events" ("tenant_id", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_type_idx" ON "billing_events" ("event_type");
