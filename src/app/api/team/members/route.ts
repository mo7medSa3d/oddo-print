import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers, users } from "../../../../db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { writeAuditEvent } from "../../../../lib/audit";
import { queryWithTimeout } from "../../../../db/client";
import { clampListLimit } from "../../../../lib/request-limits";
import {
  revokeUserTenantRefreshFamiliesInTransaction,
} from "../../../../lib/session-tokens";

const ASSIGNABLE_ROLES = ["admin", "operator", "viewer", "integration_admin", "billing_admin"] as const;

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  if (!claims?.userId || !hasManagerPermission(claims, "users.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const limit = clampListLimit(searchParams.get("limit"), 50, 100);
  const offset = Number(searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    return NextResponse.json({ error: "Invalid offset" }, { status: 400 });
  }

  const [rows, countRows] = await Promise.all([
    queryWithTimeout(
      () => db
        .select({
          userId: tenantUsers.userId,
          email: users.email,
          role: tenantUsers.role,
          createdAt: tenantUsers.createdAt,
        })
        .from(tenantUsers)
        .innerJoin(users, eq(users.id, tenantUsers.userId))
        .where(eq(tenantUsers.tenantId, claims.tenantId))
        .orderBy(desc(tenantUsers.createdAt), desc(tenantUsers.userId))
        .offset(offset)
        .limit(limit + 1),
      5_000,
      "teamMembersList",
    ),
    queryWithTimeout(
      () => db
        .select({ total: sql<number>`count(*)::int` })
        .from(tenantUsers)
        .where(eq(tenantUsers.tenantId, claims.tenantId)),
      5_000,
      "teamMembersCount",
    ),
  ]);

  return NextResponse.json({
    members: rows.slice(0, limit),
    hasMore: rows.length > limit,
    offset,
    limit,
    total: countRows[0]?.total ?? 0,
  });
}

export async function PATCH(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { userId?: unknown; role?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const userId = typeof body.userId === "string" ? body.userId : "";
  const role = typeof body.role === "string" ? body.role : "";
  if (!userId || !ASSIGNABLE_ROLES.includes(role as (typeof ASSIGNABLE_ROLES)[number])) return NextResponse.json({ error: "Invalid member update" }, { status: 400 });

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
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

      await revokeUserTenantRefreshFamiliesInTransaction(
        tx,
        userId,
        claims.tenantId,
        "role_changed",
      );

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
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });
  if (userId === claims.userId) return NextResponse.json({ error: "Use ownership transfer or leave-workspace flow before removing yourself" }, { status: 409 });

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
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

      await revokeUserTenantRefreshFamiliesInTransaction(
        tx,
        userId,
        claims.tenantId,
        "member_removed",
      );

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