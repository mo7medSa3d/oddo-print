-- 0074: orphan cleanup for ephemeral token tables, drop dead applications table.
--
-- Ephemeral token rows (email verification, password reset, invitations)
-- must not survive their user/tenant: cascade them instead of orphaning.
-- The applications table has been dead since introduction (no code or FK
-- references it).
--
-- NOTE: printers/discovered_devices intentionally keep UNIQUE(tenant_id, id)
-- instead of a formal PRIMARY KEY — the CI release gate
-- ("Verify final runtime-only schema") pins that design (no *_pkey on
-- those tables). A UNIQUE NOT NULL index fully supports a future
-- REPLICA IDENTITY USING INDEX if logical replication is ever needed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_user_id_users_id_fk') THEN
    ALTER TABLE "email_verification_tokens" DROP CONSTRAINT "email_verification_tokens_user_id_users_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_user_id_users_id_fk') THEN
    ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_tokens_user_id_users_id_fk') THEN
    ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "password_reset_tokens_user_id_users_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_tokens_user_id_users_id_fk') THEN
    ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_tenant_id_tenants_id_fk') THEN
    ALTER TABLE "tenant_invitations" DROP CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_tenant_id_tenants_id_fk') THEN
    ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_inviter_user_id_users_id_fk') THEN
    ALTER TABLE "tenant_invitations" DROP CONSTRAINT "tenant_invitations_inviter_user_id_users_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitations_inviter_user_id_users_id_fk') THEN
    ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "applications";
