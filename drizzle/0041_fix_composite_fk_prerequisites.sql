-- Forward repair migration: ensure all referenced composite unique constraints and composite foreign keys exist safely.

-- 1. agents (tenant_id, id)
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, id, COUNT(*)
    FROM agents
    GROUP BY tenant_id, id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique constraint agents_tenant_id_unique: duplicate (tenant_id, id) rows found in agents';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agents_tenant_id_unique'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint

-- 2. api_keys (tenant_id, id)
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, id, COUNT(*)
    FROM api_keys
    GROUP BY tenant_id, id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique constraint api_keys_tenant_id_unique: duplicate (tenant_id, id) rows found in api_keys';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'api_keys_tenant_id_unique'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint

-- 3. printers (tenant_id, id)
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, id, COUNT(*)
    FROM printers
    GROUP BY tenant_id, id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique constraint printers_tenant_id_unique: duplicate (tenant_id, id) rows found in printers';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'printers_tenant_id_unique'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint

-- 4. discovery_sessions (tenant_id, id)
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, id, COUNT(*)
    FROM discovery_sessions
    GROUP BY tenant_id, id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique constraint discovery_sessions_tenant_id_unique: duplicate (tenant_id, id) rows found in discovery_sessions';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'discovery_sessions_tenant_id_unique'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint

-- 5. discovered_devices (tenant_id, id)
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, id, COUNT(*)
    FROM discovered_devices
    GROUP BY tenant_id, id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique constraint discovered_devices_tenant_id_unique: duplicate (tenant_id, id) rows found in discovered_devices';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'discovered_devices_tenant_id_unique'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint

-- 6. print_jobs (tenant_id, id)
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, id, COUNT(*)
    FROM print_jobs
    GROUP BY tenant_id, id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique constraint print_jobs_tenant_id_unique: duplicate (tenant_id, id) rows found in print_jobs';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'print_jobs_tenant_id_unique'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint

-- 7. Ensure composite foreign key printers -> agents exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'printers_tenant_id_agent_id_agents_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "printers"
      ADD CONSTRAINT "printers_tenant_id_agent_id_agents_fk"
      FOREIGN KEY ("tenant_id", "agent_id")
      REFERENCES "agents" ("tenant_id", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 8. Ensure composite foreign key discovery_sessions -> agents exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'discovery_sessions_tenant_id_agent_id_agents_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "discovery_sessions"
      ADD CONSTRAINT "discovery_sessions_tenant_id_agent_id_agents_fk"
      FOREIGN KEY ("tenant_id", "agent_id")
      REFERENCES "agents" ("tenant_id", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 9. Ensure composite foreign key discovered_devices -> discovery_sessions exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'discovered_devices_tenant_id_discovery_id_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "discovered_devices"
      ADD CONSTRAINT "discovered_devices_tenant_id_discovery_id_fk"
      FOREIGN KEY ("tenant_id", "discovery_id")
      REFERENCES "discovery_sessions" ("tenant_id", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 10. Ensure composite foreign key discovered_devices -> agents exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'discovered_devices_tenant_id_agent_id_agents_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "discovered_devices"
      ADD CONSTRAINT "discovered_devices_tenant_id_agent_id_agents_fk"
      FOREIGN KEY ("tenant_id", "agent_id")
      REFERENCES "agents" ("tenant_id", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 11. Ensure composite foreign key discovered_devices -> printers exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'discovered_devices_tenant_id_provisioned_printer_id_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "discovered_devices"
      ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk"
      FOREIGN KEY ("tenant_id", "provisioned_printer_id")
      REFERENCES "printers" ("tenant_id", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint

-- 12. Ensure composite foreign key print_jobs -> api_keys exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'print_jobs_tenant_id_api_key_id_api_keys_fk'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "print_jobs"
      ADD CONSTRAINT "print_jobs_tenant_id_api_key_id_api_keys_fk"
      FOREIGN KEY ("tenant_id", "api_key_id")
      REFERENCES "api_keys" ("tenant_id", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
