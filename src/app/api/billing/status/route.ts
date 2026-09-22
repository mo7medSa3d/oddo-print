import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
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
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sub = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, manager.tenantId),
    columns: { planId: true, status: true, currentPeriodEnd: true },
  });

  const liveStatuses = new Set(["trialing", "active", "past_due"]);
  const periodLive = !sub?.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
  const hasSubscription = !!sub && liveStatuses.has(sub.status) && periodLive;

  return NextResponse.json(
    {
      hasSubscription,
      status: sub?.status ?? null,
      planId: sub?.planId ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
