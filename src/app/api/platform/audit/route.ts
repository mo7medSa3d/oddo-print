import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { auditEvents, tenants } from "../../../../db/schema";
import { desc, eq } from "drizzle-orm";
import { queryWithTimeout } from "../../../../db/client";

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limitParam = parseInt(searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 100 : limitParam), 500);

  const rows = await queryWithTimeout(
    db
      .select({
        id: auditEvents.id,
        tenantId: auditEvents.tenantId,
        tenantName: tenants.name,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        action: auditEvents.action,
        resourceType: auditEvents.resourceType,
        resourceId: auditEvents.resourceId,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(tenants, eq(tenants.id, auditEvents.tenantId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit),
    5_000,
    "platformAuditLog",
  );

  return NextResponse.json({ auditEvents: rows });
}
