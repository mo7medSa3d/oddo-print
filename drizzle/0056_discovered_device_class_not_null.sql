-- Reconcile discovered_devices.device_class with the runtime schema.
--
-- src/db/schema.ts declares device_class as .notNull().default("unknown")
-- (the schema is documented as the complete source of truth for every table),
-- but migration 0010 created the column as nullable with only DEFAULT 'unknown'
-- and no later migration ever enforced NOT NULL. This makes the database agree
-- with the canonical schema by backfilling any legacy NULL rows to 'unknown'
-- and then setting the column NOT NULL, following the same pattern used by
-- 0029_enforce_tenant_id_not_null (backfill before ALTER, guarded for
-- idempotency since Drizzle replays against existing databases).

UPDATE "discovered_devices"
  SET "device_class" = 'unknown'
  WHERE "device_class" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'discovered_devices'
      AND column_name = 'device_class' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "discovered_devices" ALTER COLUMN "device_class" SET NOT NULL;
  END IF;
END $$;
