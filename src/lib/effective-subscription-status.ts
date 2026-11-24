import { sql, type SQL } from "drizzle-orm";
import { liveTenantSubscriptionPredicate } from "./entitlements";

/**
 * Single Platform Admin projection of the same transactional admission gate
 * used by the Gateway. Never call a contract "active" merely because its
 * stored status says active: a missing end, future start, entitlement block
 * or inactive tenant must fail closed.
 *
 * Keep the display precedence consistent with customerSubscriptionState:
 * suspension > not-yet-active > expired > active.
 */
export function effectiveSubscriptionStatusSql(fields: {
  tenantId: SQL;
  tenantLifecycle: SQL;
  subscriptionStatus: SQL;
  entitlementBlocked: SQL;
  currentPeriodStart: SQL;
}): SQL<string> {
  return sql<string>`CASE
    WHEN ${fields.tenantLifecycle} IS DISTINCT FROM 'active'
      OR ${fields.subscriptionStatus} = 'suspended'
      OR ${fields.entitlementBlocked} IS TRUE THEN 'suspended'
    WHEN ${liveTenantSubscriptionPredicate(fields.tenantId)} THEN 'active'
    WHEN ${fields.subscriptionStatus} IS NULL
      OR ${fields.subscriptionStatus} = 'awaiting_activation'
      OR ${fields.currentPeriodStart} IS NULL
      OR ${fields.currentPeriodStart} > clock_timestamp() THEN 'awaiting_activation'
    ELSE 'expired'
  END`;
}
