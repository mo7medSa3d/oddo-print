ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS checkout_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS checkout_plan_id text REFERENCES plans(id),
  ADD COLUMN IF NOT EXISTS checkout_idempotency_key text,
  ADD COLUMN IF NOT EXISTS checkout_session_id text,
  ADD COLUMN IF NOT EXISTS checkout_session_url text,
  ADD COLUMN IF NOT EXISTS checkout_session_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS billing_operation_id text,
  ADD COLUMN IF NOT EXISTS billing_operation_type text,
  ADD COLUMN IF NOT EXISTS billing_operation_idempotency_key text,
  ADD COLUMN IF NOT EXISTS billing_operation_subscription_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_subscriptions_checkout_status_check'
  ) THEN
    ALTER TABLE tenant_subscriptions
      ADD CONSTRAINT tenant_subscriptions_checkout_status_check
      CHECK (checkout_status IN ('none','creating','open','completed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_subscriptions_billing_operation_type_check'
  ) THEN
    ALTER TABLE tenant_subscriptions
      ADD CONSTRAINT tenant_subscriptions_billing_operation_type_check
      CHECK (billing_operation_type IS NULL OR billing_operation_type IN ('cancel','resume'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_checkout_idempotency_unique
  ON tenant_subscriptions (checkout_idempotency_key)
  WHERE checkout_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_checkout_session_unique
  ON tenant_subscriptions (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_billing_operation_unique
  ON tenant_subscriptions (billing_operation_id)
  WHERE billing_operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_billing_operation_key_unique
  ON tenant_subscriptions (billing_operation_idempotency_key)
  WHERE billing_operation_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS tenant_subscriptions_checkout_status_idx
  ON tenant_subscriptions (tenant_id, checkout_status);
