-- Preserve existing cloud registrations while adding sticky local-owner denial.
-- No historical printer/job identity, lifecycle, configuration or status changes.
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "shared_with_gateway" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "shared_with_gateway_version" text;
--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_sharing_version_check" CHECK (
  "shared_with_gateway_version" IS NULL OR (
    "shared_with_gateway_version" ~ '^[1-9][0-9]{0,18}$'
    AND "shared_with_gateway_version"::numeric <= 9223372036854775807
  )
);
