CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "family_id" text NOT NULL,
  "kind" text NOT NULL,
  "tenant_id" text REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text,
  "email" text,
  "token_hash" text NOT NULL UNIQUE,
  "issued_at" timestamp NOT NULL,
  "family_created_at" timestamp NOT NULL,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp,
  "revoked_reason" text,
  "replaced_by" text,
  "replaced_at" timestamp,
  "ip_address" text,
  "user_agent" text,
  CONSTRAINT "refresh_tokens_kind_scope_check" CHECK (
    ("kind" = 'platform' AND "tenant_id" IS NULL AND "user_id" IS NOT NULL AND "role" IS NULL)
    OR
    ("kind" IN ('manager', 'customer') AND "tenant_id" IS NOT NULL AND "role" IS NOT NULL)
  ),
  CONSTRAINT "refresh_tokens_time_order_check" CHECK (
    "family_created_at" <= "issued_at" AND "issued_at" <= "expires_at"
  )
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_replaced_by_fk'
  ) THEN
    ALTER TABLE "refresh_tokens"
      ADD CONSTRAINT "refresh_tokens_replaced_by_fk"
      FOREIGN KEY ("replaced_by") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_replaced_by_idx" ON "refresh_tokens" USING btree ("replaced_by");
