import { NextResponse } from "next/server";
import { requirePlatformOwner, requirePlatformReadAuthorityInTransaction, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { auditEvents, tenants } from "../../../../db/schema";
import { desc, eq } from "drizzle-orm";
import { queryWithTimeout } from "../../../../db/client";
import { parseStrictListLimit } from "../../../../lib/request-limits";

const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  let actor;
  try {
    actor = await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401, headers: HEADERS });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503, headers: HEADERS });
  }

  const { searchParams } = new URL(req.url);
  const limit = parseStrictListLimit(searchParams.get("limit"), 100, 500);
  if (limit === null) {
    return NextResponse.json({ error: "limit must be a positive decimal integer", code: "INVALID_LIMIT" }, { status: 400, headers: HEADERS });
  }

  try {
  const rows = await queryWithTimeout(
    () => db.transaction(async tx => {
      await requirePlatformReadAuthorityInTransaction(tx, actor);
      return tx.select({
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
      .limit(limit);
    }),
    5_000,
    "platformAuditLog",
  );

  return NextResponse.json({ auditEvents: rows }, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Audit history temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
}
