import { NextResponse } from "next/server";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { tenants, tenantSubscriptions, tenantUsers, agents, printers, plans } from "../../../../db/schema";
import { desc, eq, and, sql, type SQL } from "drizzle-orm";
import { clampListLimit } from "../../../../lib/request-limits";
import { queryWithTimeout } from "../../../../db/client";

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
  const limit = clampListLimit(searchParams.get("limit"), 300, 1000);

  const offset = Number(searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return NextResponse.json({ error: "Invalid offset" }, { status: 400 });
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  if (search.length > 200) return NextResponse.json({ error: "Search too long" }, { status: 400 });
  const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
  const conditions: SQL[] = [];
  if (search) conditions.push(sql`(lower(${tenants.id}) LIKE ${term} ESCAPE '\\' OR lower(${tenants.name}) LIKE ${term} ESCAPE '\\')`);
  const rows = await queryWithTimeout(
    () => db
      .select({
        id: tenants.id,
        name: tenants.name,
        lifecycle: tenants.lifecycle,
        lifecycleReason: tenants.lifecycleReason,
        suspendedAt: tenants.suspendedAt,
        createdAt: tenants.createdAt,
        subscriptionStatus: tenantSubscriptions.status,
        planName: plans.name,
        memberCount: sql<number>`(SELECT count(*)::int FROM ${tenantUsers} WHERE ${tenantUsers.tenantId} = ${tenants.id})`,
        agentCount: sql<number>`(SELECT count(*)::int FROM ${agents} WHERE ${agents.tenantId} = ${tenants.id})`,
        printerCount: sql<number>`(SELECT count(*)::int FROM ${printers} WHERE ${printers.tenantId} = ${tenants.id})`,
      })
      .from(tenants)
      .leftJoin(tenantSubscriptions, eq(tenantSubscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.id, tenantSubscriptions.planId))
      .where(and(...conditions))
      .orderBy(desc(tenants.createdAt), desc(tenants.id))
      .offset(offset)
      .limit(limit + 1),
    5_000,
    "platformTenantsList",
  );

  return NextResponse.json({ tenants: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit });
}
