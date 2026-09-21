import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { tenants, tenantSubscriptions, tenantUsers, agents, printers, plans } from "../../../../db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { queryWithTimeout } from "../../../../db/client";

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limitParam = parseInt(searchParams.get("limit") ?? "300", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 300 : limitParam), 1000);

  const rows = await queryWithTimeout(
    db
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
      .orderBy(desc(tenants.createdAt))
      .limit(limit),
    5_000,
    "platformTenantsList",
  );

  return NextResponse.json({ tenants: rows });
}
