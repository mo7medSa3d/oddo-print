-- Add a bounded read-only grace period for rotated Odoo integration keys.
-- Rotation revokes write capability immediately but preserves existing Odoo job
-- status reads for a short reconciliation window. After the deadline the key
-- is rejected completely by validateOdooKey.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "read_only_until" timestamp;
