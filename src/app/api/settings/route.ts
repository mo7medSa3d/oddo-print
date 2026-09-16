import { logError } from "../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { tenants, users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { validateManager } from "../../../lib/manager-auth";
import { hasManagerPermission } from "../../../lib/authorization";
import { writeAuditEvent } from "../../../lib/audit";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "tenant.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const [tenant, user] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, claims.tenantId), columns: { id: true, name: true, createdAt: true, updatedAt: true } }),
    db.query.users.findFirst({ where: eq(users.id, claims.userId), columns: { email: true } }),
  ]);
  if (!tenant || !user) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ tenant, email: user.email, role: claims.role });
}

export async function PATCH(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "tenant.update")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { name?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 120) return NextResponse.json({ error: "Workspace name must be 2-120 characters" }, { status: 400 });
  await db.update(tenants).set({ name, updatedAt: new Date() }).where(eq(tenants.id, claims.tenantId));
  await writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: claims.userId, action: "tenant.updated", resourceType: "tenant", resourceId: claims.tenantId }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  return NextResponse.json({ ok: true, name });
}
