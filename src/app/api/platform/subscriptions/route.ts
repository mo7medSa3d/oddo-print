import { NextResponse } from "next/server";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { queryWithTimeout } from "../../../../db/client";
import { tenants, tenantSubscriptions, plans } from "../../../../db/schema";
import { desc, eq, and, sql, type SQL } from "drizzle-orm";

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

  const offset = Number(searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return NextResponse.json({ error: "Invalid offset" }, { status: 400 });
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  if (search.length > 200) return NextResponse.json({ error: "Search too long" }, { status: 400 });
  const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
  const conditions: SQL[] = [];
  const filter = searchParams.get("filter") ?? "all";
  if (!["all", "active", "attention", "other"].includes(filter)) return NextResponse.json({ error: "Invalid filter" }, { status: 400 });
  if (filter === "active") conditions.push(sql`${tenantSubscriptions.status} IN ('active','trialing')`);
  if (filter === "attention") conditions.push(sql`${tenantSubscriptions.status} IN ('past_due','paused','incomplete','unpaid')`);
  if (filter === "other") conditions.push(sql`${tenantSubscriptions.status} IN ('cancelled','incomplete_expired')`);
  if (search) conditions.push(sql`(lower(${tenants.id}) LIKE ${term} ESCAPE '\\' OR lower(${tenants.name}) LIKE ${term} ESCAPE '\\' OR lower(COALESCE(${tenantSubscriptions.stripeCustomerId}, '')) LIKE ${term} ESCAPE '\\')`);
  const rows = await queryWithTimeout(
    () => db
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
      .where(and(...conditions))
      .orderBy(desc(tenants.createdAt), desc(tenants.id))
      .offset(offset)
      .limit(limit + 1),
    5_000,
    "platformSubscriptionsList",
  );

  return NextResponse.json({ subscriptions: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit });
}
