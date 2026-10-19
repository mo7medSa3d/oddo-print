import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans, tenantSubscriptions } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { isBillingAccessStatus, isSubscriptionPeriodLive } from "../../../../lib/entitlements";
import { refreshClockSkew } from "../../../../lib/database-clock";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Lightweight subscription gate for console UI.
 * Reports whether the caller's workspace has an active plan subscription
 * (trialing/active/past_due with a live period). Pairing an agent or
 * configuring a Gateway requires this; without it the operation APIs
 * return 403 SUBSCRIPTION_REQUIRED.
 */
export async function GET(req: Request) {
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await refreshClockSkew();
  const sub = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, manager.tenantId),
    columns: { planId: true, status: true, currentPeriodEnd: true, entitlementBlocked: true },
  });

  const hasSubscription =
    !!sub && !sub.entitlementBlocked && isBillingAccessStatus(sub.status)
      && (sub.status === "past_due" || isSubscriptionPeriodLive(sub.currentPeriodEnd));

  // The console chrome needs only the active plan name, not quota/usage
  // counters. An optional summary keeps the normal status probe lightweight
  // and never exposes billing details to managers without billing.read.
  const includePlanName = new URL(req.url).searchParams.get("includePlanName") === "1";
  const currentPlan = includePlanName && hasSubscription && hasManagerPermission(manager, "billing.read") && sub
    ? await db.query.plans.findFirst({
        where: eq(plans.id, sub.planId),
        columns: { name: true },
      })
    : null;

  return NextResponse.json(
    {
      hasSubscription,
      entitlementBlocked: sub?.entitlementBlocked ?? false,
      status: sub?.status ?? null,
      planId: sub?.planId ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      ...(includePlanName ? { planName: currentPlan?.name ?? null } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
