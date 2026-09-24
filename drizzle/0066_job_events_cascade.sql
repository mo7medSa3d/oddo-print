-- Job timeline rows are operational children of print_jobs. The dedicated
-- audit_events table remains the durable audit trail, while job_events must not
-- block the bounded terminal-job retention cleanup.
ALTER TABLE "job_events"
  DROP CONSTRAINT IF EXISTS "job_events_tenant_id_job_id_print_jobs_fk";

ALTER TABLE "job_events"
  ADD CONSTRAINT "job_events_tenant_id_job_id_print_jobs_fk"
  FOREIGN KEY ("tenant_id", "job_id")
  REFERENCES "print_jobs" ("tenant_id", "id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;
