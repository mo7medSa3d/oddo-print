import { NextResponse } from "next/server";
import { requirePlatformOwner, requirePlatformReadAuthorityInTransaction, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { queryWithTimeout } from "../../../../db/client";
import { tenants, tenantSubscriptions, users, apiKeys, odooInstallations } from "../../../../db/schema";
import { sql, eq } from "drizzle-orm";
import { effectiveSubscriptionStatusSql } from "../../../../lib/effective-subscription-status";
import { getCachedPlatformStats, setCachedPlatformStats } from "../../../../lib/platform-stats-cache";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  let actor: Awaited<ReturnType<typeof requirePlatformOwner>>;
  try {
    actor = await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401, headers: PRIVATE_HEADERS });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  }

  try {
    return await db.transaction(async (tx) => {
      // Hold verified owner, family and password-version shared locks throughout
      // the cached or fresh snapshot. A preflight token is never enough.
      await requirePlatformReadAuthorityInTransaction(tx, actor);
      const bypassCache = req.headers.get("x-cache-bypass") === "1" || req.headers.get("cache-control") === "no-cache";
      const cached = getCachedPlatformStats(bypassCache);
      if (cached) {
        return NextResponse.json(cached, {
          headers: { "X-Cache": "HIT", "Cache-Control": "private, no-store" },
        });
      }

      const projectedSubscriptionStatus = effectiveSubscriptionStatusSql({
        tenantId: sql`${tenants.id}`,
        tenantLifecycle: sql`${tenants.lifecycle}`,
        subscriptionStatus: sql`${tenantSubscriptions.status}`,
        entitlementBlocked: sql`${tenantSubscriptions.entitlementBlocked}`,
        currentPeriodStart: sql`${tenantSubscriptions.currentPeriodStart}`,
      });

      const [
        tenantStats,
        subscriptionStats,
        userStats,
        credentialStats,
        installationStats,
      ] = await queryWithTimeout(
        () => Promise.all([
          tx.select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${tenants.lifecycle} = 'active')::int`,
            suspended: sql<number>`count(*) filter (where ${tenants.lifecycle} = 'suspended')::int`,
            deleted: sql<number>`count(*) filter (where ${tenants.lifecycle} = 'deleted')::int`,
          }).from(tenants),

          tx.select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${projectedSubscriptionStatus} = 'active')::int`,
            awaitingActivation: sql<number>`count(*) filter (where ${projectedSubscriptionStatus} = 'awaiting_activation')::int`,
            expired: sql<number>`count(*) filter (where ${projectedSubscriptionStatus} = 'expired')::int`,
            suspended: sql<number>`count(*) filter (where ${projectedSubscriptionStatus} = 'suspended')::int`,
            attention: sql<number>`count(*) filter (where ${projectedSubscriptionStatus} IN ('awaiting_activation', 'expired'))::int`,
          }).from(tenantSubscriptions).innerJoin(tenants, eq(tenants.id, tenantSubscriptions.tenantId)),

          tx.select({
            total: sql<number>`count(*)::int`,
            verified: sql<number>`count(*) filter (where ${users.emailVerifiedAt} is not null)::int`,
          }).from(users),

          tx.select({
            total: sql<number>`count(*)::int`,
            // A rotated key can remain valid for read-only lookup during a grace window.
            active: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is null or ${apiKeys.readOnlyUntil} > clock_timestamp())::int`,
            grace: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is not null and ${apiKeys.readOnlyUntil} > clock_timestamp())::int`,
            revoked: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is not null and (${apiKeys.readOnlyUntil} is null or ${apiKeys.readOnlyUntil} <= clock_timestamp()))::int`,
          }).from(apiKeys),

          tx.select({
            total: sql<number>`count(*)::int`,
            enabled: sql<number>`count(*) filter (where ${odooInstallations.enabled} = true)::int`,
            quarantined: sql<number>`count(*) filter (where ${odooInstallations.enabled} = false)::int`,
          }).from(odooInstallations),
        ]),
        8_000,
        "platformStatsAggregate",
      );

      const business = await queryWithTimeout(() => tx.execute(sql`WITH states AS (
        SELECT s.subscription_type, s.current_period_end,
        ${effectiveSubscriptionStatusSql({
          tenantId: sql`t.id`,
          tenantLifecycle: sql`t.lifecycle`,
          subscriptionStatus: sql`s.status`,
          entitlementBlocked: sql`s.entitlement_blocked`,
          currentPeriodStart: sql`s.current_period_start`,
        })} AS effective_status
        FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id
      ) SELECT
        (SELECT count(*)::int FROM subscription_requests WHERE status = 'pending') AS "pendingRequests",
        count(*) FILTER (WHERE effective_status = 'active' AND subscription_type = 'free')::int AS free,
        count(*) FILTER (WHERE effective_status = 'active' AND subscription_type = 'paid')::int AS paid,
        count(*) FILTER (WHERE effective_status = 'active' AND current_period_end <= clock_timestamp() + interval '30 days')::int AS "expiringSoon",
        count(*) FILTER (WHERE effective_status = 'suspended')::int AS suspended,
        count(*) FILTER (WHERE effective_status = 'active')::int AS active
      FROM states`), 8_000, "platformStatsBusiness");

      const keysSummary = credentialStats[0] ?? { total: 0, active: 0, grace: 0, revoked: 0 };
      const responseBody = {
        business: business.rows[0] ?? { pendingRequests: 0, free: 0, paid: 0, expiringSoon: 0, suspended: 0, active: 0 },
        tenants: tenantStats[0] ?? { total: 0, active: 0, suspended: 0, deleted: 0 },
        subscriptions: subscriptionStats[0] ?? { total: 0, active: 0, awaitingActivation: 0, expired: 0, suspended: 0, attention: 0 },
        users: userStats[0] ?? { total: 0, verified: 0 },
        licenseKeys: keysSummary,
        integrations: {
          keys: keysSummary,
          installations: installationStats[0] ?? { total: 0, enabled: 0, quarantined: 0 },
        },
      };

      setCachedPlatformStats(responseBody);

      return NextResponse.json(responseBody, {
        headers: { "X-Cache": "MISS", "Cache-Control": "private, no-store" },
      });
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Platform statistics temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: PRIVATE_HEADERS },
    );
  }
}
