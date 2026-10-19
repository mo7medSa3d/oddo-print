-- Preserve the Windows spooler queue identity reported by Agent discovery.
ALTER TABLE "discovered_devices"
  ADD COLUMN IF NOT EXISTS "spooler_name" text;
