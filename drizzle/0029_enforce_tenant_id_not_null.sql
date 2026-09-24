ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_payload_contract_check";
--> statement-breakpoint
DO $$
DECLARE
  known_tenant text;
  tenant_count integer;
  unowned_count bigint;
BEGIN
  SELECT COUNT(*) INTO tenant_count FROM tenants;
  SELECT id INTO known_tenant FROM tenants ORDER BY created_at LIMIT 1;

  SELECT COUNT(*) INTO unowned_count FROM (
    SELECT 1 FROM agents WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM api_keys WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM print_jobs WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM printers WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM discovery_sessions WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM discovered_devices WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM applications WHERE tenant_id IS NULL
  ) x;

  IF tenant_count = 0 AND unowned_count > 0 THEN
    INSERT INTO tenants (id, name) VALUES ('legacy_default', 'Legacy installation');
    known_tenant := 'legacy_default';
    tenant_count := 1;
  END IF;

  IF unowned_count > 0 THEN
    IF tenant_count > 1 THEN
      RAISE EXCEPTION 'Cannot safely backfill tenant_id: % unowned rows exist while multiple tenants are present. Map legacy ownership first.', unowned_count;
    END IF;

    UPDATE agents SET tenant_id = known_tenant WHERE tenant_id IS NULL;
    UPDATE printers SET tenant_id = known_tenant WHERE tenant_id IS NULL;
    UPDATE api_keys SET tenant_id = known_tenant WHERE tenant_id IS NULL;
    UPDATE print_jobs SET tenant_id = known_tenant WHERE tenant_id IS NULL;
    UPDATE discovery_sessions SET tenant_id = known_tenant WHERE tenant_id IS NULL;
    UPDATE discovered_devices SET tenant_id = known_tenant WHERE tenant_id IS NULL;
    UPDATE applications SET tenant_id = known_tenant WHERE tenant_id IS NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_payload_contract_check"
  CHECK (
    jsonb_typeof(payload) = 'object'
    AND (
      (payload->>'type' = 'raw' AND COALESCE(payload->>'protocol', '') IN ('raw', 'escpos', 'zpl', 'tspl'))
      OR (payload->>'type' = 'escpos' AND COALESCE(payload->>'protocol', '') = 'escpos')
      OR (payload->>'type' = 'pdf' AND COALESCE(payload->>'protocol', '') = '')
      OR (payload->>'type' = 'image' AND COALESCE(payload->>'protocol', '') = '')
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "print_jobs" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "printers" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovered_devices" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "tenant_id" SET NOT NULL;
