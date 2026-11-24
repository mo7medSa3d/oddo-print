import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { plans, tenantSubscriptions, tenants, subscriptionRequests } from "../db/schema";
import type { ManagerClaims } from "./manager-auth";
import { requireActiveTenantInTransaction } from "./tenant-guard";
import { requireManagerActorInTransaction } from "./manager-mutation-authorization";
import { effectiveManualEntitlements } from "./entitlements";
import { quotaCycleEndSql } from "./quota-cycle";
import { logWarn } from "./log";

type BillingPageUsage = {
  used: number;
  limit: number | "unlimited";
  remaining: number | "unlimited";
  reset: Date;
};

/**
 * Owner-only server-rendered billing data needs the same durable authority
 * boundary as GET /api/billing/usage. Hold tenant lifecycle, current membership
 * and session fences until contract, request history and quota are all read.
 */
export async function loadOwnerBillingPageSnapshot(claims: ManagerClaims) {
  return db.transaction(async tx => {
    await requireActiveTenantInTransaction(tx, claims.tenantId);
    await requireManagerActorInTransaction(tx, claims, "billing.read");

    const sub = await tx.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    });
    const tenant = await tx.query.tenants.findFirst({
      where: eq(tenants.id, claims.tenantId),
      columns: { lifecycle: true },
    });
    const requests = await tx.query.subscriptionRequests.findMany({
      where: eq(subscriptionRequests.tenantId, claims.tenantId),
      orderBy: desc(subscriptionRequests.createdAt),
      limit: 1,
    });
    const plan = sub ? await tx.query.plans.findFirst({
      where: eq(plans.id, sub.planId),
      columns: { name: true, entitlements: true, priceMinorUnits: true, priceCurrency: true },
    }) : null;

    let usage: BillingPageUsage | null = null;
    if (sub && plan) {
      try {
        const quota = effectiveManualEntitlements(plan.entitlements, sub.monthlyQuota).max_prints_per_period;
        const row = await tx.execute(sql`SELECT 0::int AS used,
          (${quotaCycleEndSql()}) AT TIME ZONE 'UTC' AS reset
          FROM tenant_subscriptions s
          WHERE s.tenant_id=${claims.tenantId}`);
        const used = Number(row.rows[0]?.used ?? 0);
        const reset = new Date(String(row.rows[0]?.reset));
        if (!Number.isSafeInteger(used) || used < 0 || !Number.isFinite(reset.getTime())) {
          throw new Error("Usage unavailable");
        }
        usage = { used, limit: quota, remaining: quota === "unlimited" ? "unlimited" : Math.max(0, quota - used), reset };
      } catch {
        logWarn("billing.monthly_usage_unavailable", { tenantId: claims.tenantId });
      }
    }
    return { sub, tenant, requests, plan, usage };
  });
}
