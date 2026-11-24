import { NextResponse } from "next/server";
import { requirePlatformOwner, requirePlatformReadAuthorityInTransaction, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { tenants, tenantSubscriptions, tenantUsers, plans } from "../../../../db/schema";
import { desc, eq, and, sql, type SQL } from "drizzle-orm";
import { clampListLimit, parseStrictListOffset } from "../../../../lib/request-limits";
import { queryWithTimeout } from "../../../../db/client";
import { effectiveSubscriptionStatusSql } from "../../../../lib/effective-subscription-status";

const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  let actor: Awaited<ReturnType<typeof requirePlatformOwner>>;
  try {
    actor = await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401, headers: HEADERS });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503, headers: HEADERS });
  }

  const { searchParams } = new URL(req.url);
  const limit = clampListLimit(searchParams.get("limit"), 300, 1000);

  const offset = parseStrictListOffset(searchParams.get("offset"), 1_000_000);
  if (offset === null) return NextResponse.json({ error: "Invalid offset", code: "INVALID_OFFSET" }, { status: 400, headers: HEADERS });
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  if (search.length > 200) return NextResponse.json({ error: "Search too long" }, { status: 400, headers: HEADERS });
  const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
  const conditions: SQL[] = [];
  if (search) conditions.push(sql`(lower(${tenants.id}) LIKE ${term} ESCAPE '\\' OR lower(${tenants.name}) LIKE ${term} ESCAPE '\\')`);
  try {
  const rows = await queryWithTimeout(
    () => db.transaction(async tx => {
      await requirePlatformReadAuthorityInTransaction(tx, actor);
      return tx.select({
        id: tenants.id,
        name: tenants.name,
        lifecycle: tenants.lifecycle,
        lifecycleReason: tenants.lifecycleReason,
        suspendedAt: tenants.suspendedAt,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
        subscriptionStatus: effectiveSubscriptionStatusSql({
          tenantId: sql`${tenants.id}`,
          tenantLifecycle: sql`${tenants.lifecycle}`,
          subscriptionStatus: sql`${tenantSubscriptions.status}`,
          entitlementBlocked: sql`${tenantSubscriptions.entitlementBlocked}`,
          currentPeriodStart: sql`${tenantSubscriptions.currentPeriodStart}`,
        }),
        planName: plans.name,
        memberCount: sql<number>`(SELECT count(*)::int FROM ${tenantUsers} WHERE ${tenantUsers.tenantId} = ${tenants.id})`,
        agentCount: sql<number>`0`,
        printerCount: sql<number>`0`,
      })
      .from(tenants)
      .leftJoin(tenantSubscriptions, eq(tenantSubscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.id, tenantSubscriptions.planId))
      .where(and(...conditions))
      .orderBy(desc(tenants.createdAt), desc(tenants.id))
      .offset(offset)
      .limit(limit + 1);
    }),
    5_000,
    "platformTenantsList",
  );

  return NextResponse.json({ tenants: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit }, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Workspace directory temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
}
