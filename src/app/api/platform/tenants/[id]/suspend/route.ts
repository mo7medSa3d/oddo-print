import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../../../lib/platform-auth";
import { db } from "../../../../../../db";
import { tenants, managerSessions } from "../../../../../../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { hasBodyOverLimit } from "../../../../../../lib/request-limits";
import { writeAuditEvent } from "../../../../../../lib/audit";
import { logError } from "../../../../../../lib/log";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  let claims;
  try {
    claims = await requirePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Tenant ID is required" }, { status: 400 });
  }

  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 500) {
    return NextResponse.json({ error: "A valid suspension reason (1-500 characters) is required" }, { status: 400 });
  }

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, id),
    columns: { id: true, lifecycle: true },
  });

  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  if (tenant.lifecycle === "suspended") {
    return NextResponse.json({ error: "Tenant is already suspended" }, { status: 400 });
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(tenants)
      .set({
        lifecycle: "suspended",
        suspendedAt: now,
        lifecycleReason: reason,
        updatedAt: now,
      })
      .where(eq(tenants.id, id));

    await tx
      .update(managerSessions)
      .set({ revokedAt: now })
      .where(and(eq(managerSessions.tenantId, id), isNull(managerSessions.revokedAt)));
  });

  void writeAuditEvent({
    tenantId: id,
    actorType: "platform",
    actorId: claims.userId,
    action: "tenant.suspended",
    resourceType: "tenant",
    resourceId: id,
    metadata: { reason },
  }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));

  return NextResponse.json({ ok: true, tenantId: id, lifecycle: "suspended", reason });
}
