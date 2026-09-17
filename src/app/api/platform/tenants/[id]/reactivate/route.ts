import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../../../lib/platform-auth";
import { db } from "../../../../../../db";
import { tenants } from "../../../../../../db/schema";
import { eq } from "drizzle-orm";
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

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, id),
    columns: { id: true, lifecycle: true },
  });

  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  if (tenant.lifecycle === "active") {
    return NextResponse.json({ error: "Tenant is already active" }, { status: 400 });
  }

  const now = new Date();
  await db
    .update(tenants)
    .set({
      lifecycle: "active",
      suspendedAt: null,
      lifecycleReason: null,
      updatedAt: now,
    })
    .where(eq(tenants.id, id));

  void writeAuditEvent({
    tenantId: id,
    actorType: "platform",
    actorId: claims.userId,
    action: "tenant.reactivated",
    resourceType: "tenant",
    resourceId: id,
  }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));

  return NextResponse.json({ ok: true, tenantId: id, lifecycle: "active" });
}
