-- Give each Agent a durable discovery identity key so repeated scans converge
-- on one candidate instead of creating a random row every time.
ALTER TABLE discovered_devices
  ADD COLUMN IF NOT EXISTS identity_key text;

-- Existing rows have no trusted cross-scan identity. Use their immutable row ID
-- as a compatibility identity; new Agent reports populate the real stable key.
UPDATE discovered_devices
SET identity_key = 'legacy:' || id
WHERE identity_key IS NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS discovered_devices_tenant_agent_identity_unique
  ON discovered_devices (tenant_id, agent_id, identity_key);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discovered_devices_tenant_agent_identity_idx
  ON discovered_devices (tenant_id, agent_id, identity_key);
