-- Enforce tenant/object integrity for the enterprise job timeline.
-- Historical orphan rows are not silently rewritten: deployment must stop so an
-- operator can reconcile them before the database constraint is activated.
DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT COUNT(*)
    INTO orphan_count
  FROM job_events e
  LEFT JOIN print_jobs j
    ON j.tenant_id = e.tenant_id
   AND j.id = e.job_id
  WHERE j.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add job_events tenant-scoped foreign key: % orphan event rows reference missing or cross-tenant print jobs',
      orphan_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'job_events_tenant_id_job_id_print_jobs_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "job_events"
      ADD CONSTRAINT "job_events_tenant_id_job_id_print_jobs_fk"
      FOREIGN KEY ("tenant_id", "job_id")
      REFERENCES "print_jobs" ("tenant_id", "id")
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END $$;
