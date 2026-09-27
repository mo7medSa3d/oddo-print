-- 0074: formal composite primary keys for tenant-scoped identity tables,
-- orphan cleanup for ephemeral token tables, drop dead applications table.
--
-- Migration 0072 dropped the single-column pkeys on printers and
-- discovered_devices (tenant-scoped identity) but left only UNIQUE
-- constraints. Formal composite PRIMARY KEYs restore ORM, replication
-- (logical replication requires a replica identity), and tooling
-- expectations. Dropping a UNIQUE that foreign keys depend on fails, so
-- the two FKs into printers(tenant_id, id) are dropped first and
-- re-added unchanged afterwards.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_tenant_id_provisioned_printer_id_fk') THEN
    ALTER TABLE "discovered_devices" DROP CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk') THEN
    ALTER TABLE "print_jobs" DROP CONSTRAINT "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_tenant_id_unique') THEN
    ALTER TABLE "printers" DROP CONSTRAINT "printers_tenant_id_unique";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_pkey') THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_pkey" PRIMARY KEY ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_tenant_id_provisioned_printer_id_fk') THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk" FOREIGN KEY ("tenant_id", "provisioned_printer_id") REFERENCES "printers"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk') THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "printers"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_tenant_id_unique') THEN
    ALTER TABLE "discovered_devices" DROP CONSTRAINT "discovered_devices_tenant_id_unique";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_pkey') THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_pkey" PRIMARY KEY ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint
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
