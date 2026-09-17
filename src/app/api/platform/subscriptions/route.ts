import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { tenants, tenantSubscriptions, plans } from "../../../../db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
  }

  const rows = await db
    .select({
      tenantId: tenants.id,
      tenantName: tenants.name,
      tenantLifecycle: tenants.lifecycle,
      planId: tenantSubscriptions.planId,
      planName: plans.name,
      stripeCustomerId: tenantSubscriptions.stripeCustomerId,
      stripeSubscriptionId: tenantSubscriptions.stripeSubscriptionId,
      status: tenantSubscriptions.status,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      trialStartedAt: tenantSubscriptions.trialStartedAt,
      cancelAtPeriodEnd: tenantSubscriptions.cancelAtPeriodEnd,
      createdAt: tenantSubscriptions.createdAt,
    })
    .from(tenantSubscriptions)
    .innerJoin(tenants, eq(tenants.id, tenantSubscriptions.tenantId))
    .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
    .orderBy(desc(tenantSubscriptions.createdAt));

  return NextResponse.json({ subscriptions: rows });
}
