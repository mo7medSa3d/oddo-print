import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { tenants, tenantSubscriptions, tenantUsers, agents, printers, plans } from "../../../../db/schema";
import { desc, eq, sql } from "drizzle-orm";

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
  }

  const rows = await db
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
    .orderBy(desc(tenants.createdAt));

  return NextResponse.json({ tenants: rows });
}
