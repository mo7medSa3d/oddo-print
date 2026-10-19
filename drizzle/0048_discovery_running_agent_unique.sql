CREATE UNIQUE INDEX IF NOT EXISTS "discovery_sessions_active_agent_unique"
ON "discovery_sessions" ("tenant_id", "agent_id")
WHERE "status" = 'running';
