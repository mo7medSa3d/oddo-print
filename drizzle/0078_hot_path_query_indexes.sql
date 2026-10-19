-- Hot-path query support for global platform telemetry and tenant fleet lists.
-- PostgreSQL can scan these btrees backward for DESC ordering.
CREATE INDEX IF NOT EXISTS "print_jobs_created_at_idx"
  ON "print_jobs" USING btree ("created_at");

CREATE INDEX IF NOT EXISTS "audit_events_created_at_idx"
  ON "audit_events" USING btree ("created_at");

CREATE INDEX IF NOT EXISTS "agents_tenant_created_idx"
  ON "agents" USING btree ("tenant_id", "created_at");

CREATE INDEX IF NOT EXISTS "printers_tenant_created_idx"
  ON "printers" USING btree ("tenant_id", "created_at");
