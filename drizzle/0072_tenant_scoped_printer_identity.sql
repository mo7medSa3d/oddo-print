-- Printer and discovery row IDs are Agent-generated from hardware/network
-- identity (for example printer_net_<hash(ip:port)>). After multi-tenancy those
-- values must be unique per tenant, not globally: two companies can both have a
-- printer at 192.168.1.50:9100. Migration 0006 made the pre-tenant invariant
-- explicit with printers_gateway_id_global_unique; this restores tenant-scoped
-- identity while keeping UNIQUE(tenant_id, id) as the uniqueness boundary.
--
-- Composite FKs already reference printers(tenant_id, id) and
-- discovered_devices(tenant_id, id). Drop leftover single-column FKs first so
-- the global primary keys can be removed without breaking dependents.

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT child.relname AS child_table, c.conname
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE c.contype = 'f'
      AND child_ns.nspname = current_schema()
      AND parent_ns.nspname = current_schema()
      AND parent.relname = 'printers'
      AND array_length(c.confkey, 1) = 1
      AND EXISTS (
        SELECT 1
        FROM pg_attribute att
        WHERE att.attrelid = parent.oid
          AND att.attnum = c.confkey[1]
          AND att.attname = 'id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', rec.child_table, rec.conname);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_pkey";
--> statement-breakpoint
DROP INDEX IF EXISTS "printers_gateway_id_global_unique";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'printers_tenant_id_unique'
      AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "printers" REPLICA IDENTITY USING INDEX "printers_tenant_id_unique";
--> statement-breakpoint
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT child.relname AS child_table, c.conname
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE c.contype = 'f'
      AND child_ns.nspname = current_schema()
      AND parent_ns.nspname = current_schema()
      AND parent.relname = 'discovered_devices'
      AND array_length(c.confkey, 1) = 1
      AND EXISTS (
        SELECT 1
        FROM pg_attribute att
        WHERE att.attrelid = parent.oid
          AND att.attnum = c.confkey[1]
          AND att.attname = 'id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', rec.child_table, rec.conname);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "discovered_devices" DROP CONSTRAINT IF EXISTS "discovered_devices_pkey";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'discovered_devices_tenant_id_unique'
      AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "discovered_devices" REPLICA IDENTITY USING INDEX "discovered_devices_tenant_id_unique";
