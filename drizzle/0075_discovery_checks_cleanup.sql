-- 0075: discovery state-machine CHECKs + drop redundant identity index.
--
-- discovery_sessions.status writers are allowlisted to
-- running/completed/partial/failed/cancelled (agent report route + manager
-- cancel route + 'running' default; see DISCOVERY_SESSION_STATUS in
-- src/lib/discovery.ts), discovered_devices.confidence/verification are
-- zod-enum validated at the agent report boundary, and candidate_status
-- moves only discovered->verified->provisioned (verify/provision routes).
-- The CHECKs below encode exactly those domains.
--
-- Also drops discovered_devices_tenant_agent_identity_idx (0070): a plain
-- index on the same (tenant_id, agent_id, identity_key) columns as the
-- UNIQUE constraint. The unique index already serves the same lookups;
-- the duplicate only costs writes.
--
-- NOTE: printers/discovered_devices intentionally keep UNIQUE(tenant_id, id)
-- instead of a formal PRIMARY KEY — the CI release gate
-- ("Verify final runtime-only schema") pins that design. See 0074 header.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sessions_status_check') THEN
    ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_status_check" CHECK ("discovery_sessions"."status" in ('running','completed','partial','failed','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_candidate_status_check') THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_candidate_status_check" CHECK ("discovered_devices"."candidate_status" in ('discovered','verified','provisioned'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_confidence_check') THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_confidence_check" CHECK ("discovered_devices"."confidence" in ('low','medium','high'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_verification_check') THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_verification_check" CHECK ("discovered_devices"."verification" in ('candidate','verified'));
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "discovered_devices_tenant_agent_identity_idx";
