-- Desired printer reconciliation: separate manager-owned desired state from agent-owned observations.
ALTER TABLE "printers"
  ADD COLUMN IF NOT EXISTS "management_source" text NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS "desired_revision" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "applied_desired_revision" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "observed_desired_revision" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "observed_device_class" text;
--> statement-breakpoint
UPDATE "printers" SET "observed_device_class" = "device_class" WHERE "observed_device_class" IS NULL;
--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_management_source_check" CHECK ("management_source" IN ('agent','manager'));
--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_desired_revision_check" CHECK ("desired_revision" >= 0 AND "applied_desired_revision" >= 0 AND "observed_desired_revision" >= 0 AND "applied_desired_revision" <= "desired_revision" AND "observed_desired_revision" <= "applied_desired_revision");
--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_observed_device_class_check" CHECK ("observed_device_class" IS NULL OR "observed_device_class" IN ('thermal','laser','inkjet','label','other','unknown'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "printers_agent_lifecycle_desired_idx" ON "printers" ("tenant_id","agent_id","lifecycle","management_source");
