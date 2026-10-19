-- Platform Owner / Control Plane identity & session schema
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_platform_owner" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "platform_sessions" (
  "jti" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp
);

CREATE INDEX IF NOT EXISTS "platform_sessions_expires_idx" ON "platform_sessions"("expires_at");
CREATE INDEX IF NOT EXISTS "platform_sessions_user_idx" ON "platform_sessions"("user_id");
