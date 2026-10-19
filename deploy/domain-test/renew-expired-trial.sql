-- Explicit, operator-only 30-day recovery for ONE expired staging HTTP Test trial.
-- Never invoked by deployment/setup. Requires exact tenant ID AND expected prior
-- end timestamp, active workspace, expired trial, fake plan, no Stripe billing.
-- Uses UTC because current_period_* are PostgreSQL TIMESTAMP WITHOUT TIME ZONE.
-- Run only against the isolated yasser_http_test database (ON_ERROR_STOP=1).
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SELECT set_config('yaseir.trial_renewal_tenant_id', :'tenant_id', true);
SELECT set_config('yaseir.trial_renewal_expected_end', :'expected_period_end', true);

DO $staging_trial$
DECLARE
  target_id text := current_setting('yaseir.trial_renewal_tenant_id');
  expected_end timestamp := current_setting('yaseir.trial_renewal_expected_end')::timestamptz AT TIME ZONE 'UTC';
  subscription record;
  now_utc timestamp;
  new_end timestamp;
BEGIN
  IF current_database() <> 'yasser_http_test' THEN
    RAISE EXCEPTION 'Refusing to renew outside the isolated staging database';
  END IF;
  IF target_id IS NULL OR left(target_id, 4) <> 'ten_' OR length(target_id) > 80 THEN
    RAISE EXCEPTION 'Explicit, validated staging tenant ID is required';
  END IF;

  SELECT ts.*, t.lifecycle AS tenant_lifecycle
    INTO subscription
    FROM tenant_subscriptions ts
    JOIN tenants t ON t.id = ts.tenant_id
   WHERE ts.tenant_id = target_id
   FOR UPDATE OF ts;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No matching tenant subscription; nothing changed';
  END IF;
  IF subscription.tenant_lifecycle <> 'active'
     OR subscription.plan_id <> 'http-test'
     OR subscription.status <> 'trialing'
     OR subscription.stripe_customer_id IS NOT NULL
     OR subscription.stripe_subscription_id IS NOT NULL
     OR subscription.entitlement_blocked IS TRUE
     OR subscription.cancel_at_period_end IS TRUE
     OR subscription.checkout_status <> 'none'
     OR subscription.billing_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to alter production, paid, blocked or changing subscriptions';
  END IF;

  now_utc := clock_timestamp() AT TIME ZONE 'UTC';
  IF subscription.current_period_end IS NULL OR subscription.current_period_end >= now_utc THEN
    RAISE EXCEPTION 'The HTTP Test trial is not expired; no renewal needed';
  END IF;
  IF date_trunc('milliseconds', subscription.current_period_end) <> expected_end THEN
    RAISE EXCEPTION 'Expected period end does not match the DB; recheck selected tenant';
  END IF;

  new_end := now_utc + interval '30 days';
  UPDATE tenant_subscriptions
     SET current_period_start = now_utc,
         current_period_end = new_end,
         updated_at = now_utc
   WHERE tenant_id = target_id;
  -- Preserve historical print_usage_periods and trial_started_at; the new
  -- period_start naturally creates a new (independent) quota usage period.
  INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
  VALUES (
    'audit_' || substr(md5(clock_timestamp()::text || random()::text || target_id), 1, 14),
    target_id, 'system', 'staging-operator', 'billing.staging_trial_renewed',
    'tenant_subscription', target_id,
    jsonb_build_object(
      'planId', subscription.plan_id,
      'previousPeriodEnd', subscription.current_period_end,
      'newPeriodStart', now_utc,
      'newPeriodEnd', new_end,
      'explicitOperatorAction', true
    )
  );
  RAISE NOTICE 'Renewed the selected HTTP Test tenant %: % through % (UTC)', target_id, now_utc, new_end;
END
$staging_trial$;
COMMIT;
