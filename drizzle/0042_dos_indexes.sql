-- DoS hardening: support bounded tenant/agent admission queries without
-- repeatedly scanning large print_jobs partitions under print-job flooding.
CREATE INDEX IF NOT EXISTS print_jobs_tenant_created_idx
  ON print_jobs(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS print_jobs_tenant_agent_status_expiry_idx
  ON print_jobs(tenant_id, agent_id, status, expires_at);
