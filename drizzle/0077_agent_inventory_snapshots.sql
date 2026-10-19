ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "inventory_snapshot_id" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "inventory_snapshot_page_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "inventory_snapshot_next_page" integer NOT NULL DEFAULT 1;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "inventory_snapshot_complete" boolean NOT NULL DEFAULT false;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "inventory_snapshot_had_errors" boolean NOT NULL DEFAULT false;

ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "inventory_present" boolean NOT NULL DEFAULT true;
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "inventory_snapshot_id" text;

CREATE INDEX IF NOT EXISTS "printers_agent_inventory_present_idx"
  ON "printers" ("tenant_id", "agent_id", "management_source", "inventory_present");
