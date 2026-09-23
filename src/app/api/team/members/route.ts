import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers, users } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
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

  try {
    await db.transaction(async (tx) => {
      const target = await tx.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId)),
        columns: { role: true },
      });
      if (!target) throw new TeamMemberConflict("Member not found", 404);
      if (target.role === "owner") throw new TeamMemberConflict("Owner role must be transferred explicitly", 409);

      const updated = await tx.update(tenantUsers)
        .set({ role, updatedAt: sql`now()` })
        .where(and(
          eq(tenantUsers.tenantId, claims.tenantId),
          eq(tenantUsers.userId, userId),
          eq(tenantUsers.role, target.role),
        ))
        .returning({ userId: tenantUsers.userId });
      if (updated.length !== 1) throw new TeamMemberConflict("Member changed concurrently; refresh and try again", 409);

      await writeAuditEvent({
        tenantId: claims.tenantId,
        actorType: "user",
        actorId: claims.userId,
        action: "team.member.role_changed",
        resourceType: "user",
        resourceId: userId,
        metadata: { role },
      }, tx);
    });
  } catch (error) {
    if (error instanceof TeamMemberConflict) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });
  if (userId === claims.userId) return NextResponse.json({ error: "Use ownership transfer or leave-workspace flow before removing yourself" }, { status: 409 });

  try {
    await db.transaction(async (tx) => {
      const target = await tx.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId)),
        columns: { role: true },
      });
      if (!target) throw new TeamMemberConflict("Member not found", 404);
      if (target.role === "owner") throw new TeamMemberConflict("Transfer ownership before removing the owner", 409);

      const deleted = await tx.delete(tenantUsers)
        .where(and(
          eq(tenantUsers.tenantId, claims.tenantId),
          eq(tenantUsers.userId, userId),
          eq(tenantUsers.role, target.role),
        ))
        .returning({ userId: tenantUsers.userId });
      if (deleted.length !== 1) throw new TeamMemberConflict("Member changed concurrently; refresh and try again", 409);

      await writeAuditEvent({
        tenantId: claims.tenantId,
        actorType: "user",
        actorId: claims.userId,
        action: "team.member.removed",
        resourceType: "user",
        resourceId: userId,
      }, tx);
    });
  } catch (error) {
    if (error instanceof TeamMemberConflict) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return NextResponse.json({ ok: true });
}

class TeamMemberConflict extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}