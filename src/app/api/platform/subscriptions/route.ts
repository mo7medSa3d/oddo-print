import { NextResponse } from "next/server";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { queryWithTimeout } from "../../../../db/client";
import { tenants, tenantSubscriptions, plans } from "../../../../db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const limitParam = parseInt(searchParams.get("limit") ?? "300", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 300 : limitParam), 1000);

  const rows = await queryWithTimeout(
    db
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
        createdAt: tenants.createdAt,
      })
      .from(tenantSubscriptions)
      .innerJoin(tenants, eq(tenantSubscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.id, tenantSubscriptions.planId))
      .orderBy(desc(tenants.createdAt))
      .limit(limit),
    5_000,
    "platformSubscriptionsList",
  );

  return NextResponse.json({ subscriptions: rows });
}
