import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans, tenantSubscriptions, tenants } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../../../../lib/tenant-guard";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../lib/manager-mutation-authorization";
import { eq } from "drizzle-orm";
import { customerSubscriptionState } from "../../../../lib/manual-subscriptions";
import { databaseNowMs } from "../../../../lib/database-clock";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

/** Availability for every member; contract dates remain owner-only. */
export async function GET(req: Request) {
  const member = await validateWorkspaceManager(req);
  if (!member) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401, headers: PRIVATE_HEADERS });
  const includePlanName = new URL(req.url).searchParams.get("includePlanName") === "1";
  try {
    // A request can outlive cookie preflight. Fence the current tenant,
    // membership and session before exposing even owner-only contract dates.
    const [subscription, tenant, plan] = await db.transaction(async tx => {
      await requireActiveTenantInTransaction(tx, member.tenantId);
      await requireManagerActorInTransaction(tx, member, "tenant.read");
      const subscription = await tx.query.tenantSubscriptions.findFirst({
        where: eq(tenantSubscriptions.tenantId, member.tenantId),
      });
      const tenant = await tx.query.tenants.findFirst({
        where: eq(tenants.id, member.tenantId), columns: { lifecycle: true },
      });
      const plan = includePlanName && subscription
        ? await tx.query.plans.findFirst({ where: eq(plans.id, subscription.planId), columns: { name: true } })
        : null;
      return [subscription, tenant, plan] as const;
    });
    const status = customerSubscriptionState(subscription, tenant?.lifecycle, await databaseNowMs());
    return NextResponse.json({
      hasSubscription: status === "active",
      status, customerState: status,
      entitlementBlocked: subscription?.entitlementBlocked ?? false,
      ...(includePlanName ? { planName: plan?.name ?? null } : {}),
      // The workspace owner has billing.read, unlike invited Full Access.
      ...(member.role === "owner" ? { currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null } : {}),
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: PRIVATE_HEADERS });
    }
    if (error instanceof ManagerMutationAuthorityChangedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: PRIVATE_HEADERS });
    }
    logError("billing.workspace_status_read_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Subscription status unavailable", code: "SUBSCRIPTION_STATUS_UNAVAILABLE" },
      { status: 503, headers: PRIVATE_HEADERS });
  }
}
