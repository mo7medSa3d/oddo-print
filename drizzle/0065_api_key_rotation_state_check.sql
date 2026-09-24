-- Prevent an invalid Odoo API-key lifecycle where a key is marked
-- read-only without also being fully revoked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM api_keys
    WHERE read_only_until IS NOT NULL
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot add api_keys_read_only_until_check: active API keys cannot carry read_only_until';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'api_keys_read_only_until_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "api_keys"
      ADD CONSTRAINT "api_keys_read_only_until_check"
      CHECK ("read_only_until" IS NULL OR "revoked_at" IS NOT NULL);
  END IF;
END $$;
