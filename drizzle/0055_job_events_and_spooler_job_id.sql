-- 0055: Enterprise upgrades — job_events timeline + spooler_job_id linking (Gateway↔Spooler)
-- Non-breaking: adds nullable columns and new table, no existing data mutation.

-- Add spooler_job_id and attempt_id to print_jobs (nullable, for backward compat)
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS spooler_job_id TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS attempt_id TEXT;

-- Job events timeline table for Real Print Certification Mode and Job Timeline
CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  stage TEXT NOT NULL CHECK (stage IN ('created','queued','claimed','accepted','connection','printing','delivery','success','failed','expired','blocked')),
  status TEXT NOT NULL CHECK (status IN ('ok','error','blocked','pending')),
  attempt_id TEXT,
  claim_id TEXT,
  spooler_job_id TEXT,
  agent_id TEXT,
  printer_id TEXT,
  request_id TEXT,
  message TEXT,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_events_job_id_idx ON job_events(job_id);
CREATE INDEX IF NOT EXISTS job_events_tenant_job_idx ON job_events(tenant_id, job_id);
CREATE INDEX IF NOT EXISTS job_events_created_idx ON job_events(created_at);
CREATE INDEX IF NOT EXISTS job_events_stage_idx ON job_events(stage);
