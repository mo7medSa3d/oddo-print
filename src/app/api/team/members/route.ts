import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers, users } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { writeAuditEvent } from "../../../../lib/audit";

const ASSIGNABLE_ROLES = ["admin", "operator", "viewer", "integration_admin", "billing_admin"] as const;

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await db.select({ userId: tenantUsers.userId, email: users.email, role: tenantUsers.role, createdAt: tenantUsers.createdAt })
    .from(tenantUsers).innerJoin(users, eq(users.id, tenantUsers.userId)).where(eq(tenantUsers.tenantId, claims.tenantId));
  return NextResponse.json({ members: rows });
}

export async function PATCH(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { userId?: unknown; role?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const userId = typeof body.userId === "string" ? body.userId : "";
  const role = typeof body.role === "string" ? body.role : "";
  if (!userId || !ASSIGNABLE_ROLES.includes(role as (typeof ASSIGNABLE_ROLES)[number])) return NextResponse.json({ error: "Invalid member update" }, { status: 400 });
  const target = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId)), columns: { role: true } });
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (target.role === "owner") return NextResponse.json({ error: "Owner role must be transferred explicitly" }, { status: 409 });
  await db.transaction(async (tx) => {
    await tx.update(tenantUsers).set({ role, updatedAt: new Date() }).where(and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId)));
    await writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: claims.userId, action: "team.member.role_changed", resourceType: "user", resourceId: userId, metadata: { role } }, tx);
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });
  if (userId === claims.userId) return NextResponse.json({ error: "Use ownership transfer or leave-workspace flow before removing yourself" }, { status: 409 });
  const target = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId)), columns: { role: true } });
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (target.role === "owner") return NextResponse.json({ error: "Transfer ownership before removing the owner" }, { status: 409 });
  await db.transaction(async (tx) => {
    await tx.delete(tenantUsers).where(and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId)));
    await writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: claims.userId, action: "team.member.removed", resourceType: "user", resourceId: userId }, tx);
  });
  return NextResponse.json({ ok: true });
}
