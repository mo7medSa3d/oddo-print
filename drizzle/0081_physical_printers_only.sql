-- Physical-printer-only cutover: remove obsolete software/redirected destinations.
-- IMPORTANT: take a database backup and stop old Agent processes before deploying.
-- Migration is atomic under the existing transaction-scoped migrator. It refuses
-- to delete an actively claimed/printing job; drain those first and re-run.
CREATE TEMP TABLE _removed_virtual_printers ON COMMIT DROP AS
SELECT tenant_id, id
FROM printers p
WHERE lower(p.printer_type) <> 'physical'
   OR lower(COALESCE(p.name,'')) ~
      '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
   OR lower(COALESCE(p.config->>'spooler_name', p.config->>'address','')) ~
      '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
   OR lower(COALESCE(p.capabilities->>'driver_name',p.capabilities->>'driverName','')) ~
      '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
   OR p.config ? 'virtual_test_sink'
   OR p.config ? 'virtual_spooler_test'
   OR p.capabilities @> '{"virtual": true}'::jsonb
   OR p.capabilities @> '{"is_virtual": true}'::jsonb
   OR p.capabilities @> '{"virtual_test_sink": true}'::jsonb
   OR p.capabilities @> '{"virtual_spooler_test": true}'::jsonb
   OR lower(COALESCE(p.capabilities->>'printer_class', '')) IN ('virtual','redirected')
   OR lower(COALESCE(p.capabilities->>'port_name', '')) ~ '^(portprompt:|xpsport:|file:|nul:|null:|shrfax:|fax:)';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM print_jobs j JOIN _removed_virtual_printers v
      ON v.tenant_id = j.tenant_id AND v.id = j.printer_id
    WHERE j.status IN ('claimed','printing')
  ) THEN
    RAISE EXCEPTION 'Physical-only printer migration blocked: a virtual-printer job is still claimed/printing; drain it and retry';
  END IF;
END $$;
--> statement-breakpoint
-- Remove ephemeral discovery observations first, then virtual-only history;
-- print job events cascade with their job. Real-printer records are untouched.
DELETE FROM discovered_devices d USING _removed_virtual_printers v
WHERE d.tenant_id = v.tenant_id AND d.provisioned_printer_id = v.id;
--> statement-breakpoint
DELETE FROM discovered_devices d WHERE
  lower(COALESCE(d.spooler_name,d.device_name,'')) ~
    '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
  OR d.capabilities @> '{"virtual": true}'::jsonb
  OR d.capabilities @> '{"is_virtual": true}'::jsonb
  OR lower(COALESCE(d.capabilities->>'printer_class','')) IN ('virtual','redirected')
  OR lower(COALESCE(d.capabilities->>'port_name','')) ~ '^(portprompt:|xpsport:|file:|nul:|null:|shrfax:|fax:)';
--> statement-breakpoint
-- On fresh databases print_job_receipts is created by the historical
-- AUDIT_REPAIRS phase *after* versioned migrations. Existing deployments may
-- already have it. Do not require the table before its creation in either case.
DO $$
BEGIN
  IF to_regclass('print_job_receipts') IS NOT NULL THEN
    DELETE FROM print_job_receipts r USING _removed_virtual_printers v
    WHERE r.tenant_id = v.tenant_id AND r.printer_id = v.id;
  END IF;
END $$;
--> statement-breakpoint
DELETE FROM print_jobs j USING _removed_virtual_printers v
WHERE j.tenant_id = v.tenant_id AND j.printer_id = v.id;
--> statement-breakpoint
DELETE FROM printers p USING _removed_virtual_printers v
WHERE p.tenant_id = v.tenant_id AND p.id = v.id;
--> statement-breakpoint
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_type_check;
--> statement-breakpoint
ALTER TABLE printers ADD CONSTRAINT printers_type_check CHECK (
  printer_type = 'physical'
  AND lower(COALESCE(name,'')) !~ '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
  AND lower(COALESCE(config->>'spooler_name',config->>'address','')) !~ '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
  AND lower(COALESCE(capabilities->>'driver_name',capabilities->>'driverName','')) !~ '(microsoft print to pdf|onenote|xps document writer|pdf24|pdfcreator|virtual printer|print to pdf|remote desktop easy print|redirected)'
  AND lower(COALESCE(capabilities->>'port_name','')) !~ '^(portprompt:|xpsport:|file:|nul:|null:|shrfax:|fax:)'
  AND lower(COALESCE(capabilities->>'printer_class','')) NOT IN ('virtual','redirected')
  AND NOT COALESCE(config ? 'virtual_test_sink', false)
  AND NOT COALESCE(config ? 'virtual_spooler_test', false)
  AND NOT COALESCE(capabilities @> '{"virtual": true}'::jsonb, false)
  AND NOT COALESCE(capabilities @> '{"is_virtual": true}'::jsonb, false)
  AND NOT COALESCE(capabilities @> '{"virtual_test_sink": true}'::jsonb, false)
  AND NOT COALESCE(capabilities @> '{"virtual_spooler_test": true}'::jsonb, false)
);
