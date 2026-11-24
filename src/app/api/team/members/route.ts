import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantInvitations, tenantUsers, users } from "../../../../db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../../../../lib/tenant-guard";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../lib/manager-mutation-authorization";
import { queryWithTimeout } from "../../../../db/client";
import { clampListLimit, parseStrictListOffset } from "../../../../lib/request-limits";
import { requireWorkspaceOwnerForInvites } from "../../../../lib/workspace-owner-invitations";
import { assertPlatformTeamOrigin } from "../../../../lib/platform-team-security";
import { ManualSubscriptionError } from "../../../../lib/manual-subscriptions";
import { manualApiError } from "../../../../lib/manual-api-error";
import { revokeUserTenantRefreshFamiliesInTransaction } from "../../../../lib/session-tokens";
import { writeAuditEvent } from "../../../../lib/audit";
import { platformOwnerRequiredResponse } from "../../../../lib/team-authorization";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401, headers: PRIVATE_HEADERS });
  if (!claims.userId || !hasManagerPermission(claims, "users.read")) {
    return NextResponse.json({ error: "Forbidden", code: "FORBIDDEN" }, { status: 403, headers: PRIVATE_HEADERS });
  }

  const { searchParams } = new URL(req.url);
  const limit = clampListLimit(searchParams.get("limit"), 50, 100);
  const offset = parseStrictListOffset(searchParams.get("offset"), 1_000_000);
  if (offset === null) {
    return NextResponse.json({ error: "Invalid offset", code: "INVALID_OFFSET" }, { status: 400, headers: PRIVATE_HEADERS });
  }

  try {
    // Validation at the HTTP boundary is only a preflight. The principal,
    // session and tenant can change before the directory query starts.
    // Keep lifecycle and durable session authority fenced until the last row
    // of the page is read, so a revoked member cannot see colleague emails.
    const [rows, countRows] = await db.transaction(async tx => {
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "users.read");
      const rows = await queryWithTimeout(
        () => tx
          .select({
            userId: tenantUsers.userId,
            email: users.email,
            role: tenantUsers.role,
            platformOwner: sql<boolean>`${users.isPlatformOwner} AND ${users.emailVerifiedAt} IS NOT NULL`,
            removableByCurrentOwner: sql<boolean>`${claims.role === "owner"} AND EXISTS (
              SELECT 1 FROM ${tenantInvitations} i
              WHERE i.tenant_id = ${tenantUsers.tenantId}
                AND i.inviter_user_id = ${claims.userId}
                AND lower(i.email) = lower(${users.email})
                AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL
            )`,
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
      );
      const countRows = await queryWithTimeout(
        () => tx
          .select({ total: sql<number>`count(*)::int` })
          .from(tenantUsers)
          .where(eq(tenantUsers.tenantId, claims.tenantId)),
        5_000,
        "teamMembersCount",
      );
      return [rows, countRows] as const;
    });

    return NextResponse.json({
      members: rows.slice(0, limit),
      hasMore: rows.length > limit,
      offset,
      limit,
      total: countRows[0]?.total ?? 0,
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: PRIVATE_HEADERS });
    }
    if (error instanceof ManagerMutationAuthorityChangedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: PRIVATE_HEADERS });
    }
    logError("team.members_directory_read_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Directory temporarily unavailable", code: "DIRECTORY_UNAVAILABLE" }, { status: 503, headers: PRIVATE_HEADERS });
  }
}

/** A workspace owner may remove only a non-owner member admitted by their accepted invite. */
export async function DELETE(req: Request) {
  try {
    assertPlatformTeamOrigin(req);
    const claims = await validateWorkspaceManager(req);
    if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    if (claims.role !== "owner") return NextResponse.json({ error: "OWNER_REQUIRED", code: "OWNER_REQUIRED" }, { status: 403, headers: PRIVATE_HEADERS });
    const userId = new URL(req.url).searchParams.get("userId") ?? "";
    if (!userId || userId.length > 128) throw new ManualSubscriptionError("MEMBER_ID_REQUIRED", 400);
    await db.transaction(async tx => {
      const tenant = await tx.execute(sql`SELECT id FROM tenants WHERE id=${claims.tenantId} FOR UPDATE`);
      if (!tenant.rows.length) throw new ManualSubscriptionError("WORKSPACE_NOT_FOUND", 404);
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireWorkspaceOwnerForInvites(tx, claims);
      const target = await tx.execute(sql`
        SELECT m.role, EXISTS (
          SELECT 1 FROM tenant_invitations i
          WHERE i.tenant_id=m.tenant_id AND i.inviter_user_id=${claims.userId}
            AND lower(i.email)=lower(u.email)
            AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL
        ) AS removable_by_owner
        FROM tenant_users m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${claims.tenantId} AND m.user_id=${userId}
        FOR UPDATE OF m
      `);
      if (!target.rows.length) throw new ManualSubscriptionError("MEMBER_NOT_FOUND", 404);
      const member = target.rows[0] as { role: string; removable_by_owner: boolean };
      if (member.role === "owner") throw new ManualSubscriptionError("TRANSFER_OWNER_FIRST", 409);
      if (!member.removable_by_owner) throw new ManualSubscriptionError("MEMBER_NOT_REMOVABLE", 403);
      const removed = await tx.delete(tenantUsers).where(and(
        eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, userId), eq(tenantUsers.role, member.role),
      )).returning({ userId: tenantUsers.userId });
      if (removed.length !== 1) throw new ManualSubscriptionError("MEMBER_CHANGED", 409);
      await revokeUserTenantRefreshFamiliesInTransaction(tx, userId, claims.tenantId, "workspace_member_removed");
      await writeAuditEvent({
        tenantId: claims.tenantId, actorType: "user", actorId: claims.userId,
        action: "team.member.removed", resourceType: "user", resourceId: userId,
      }, tx);
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return manualApiError(error); }
}

/** Role changes remain retired; 401 distinguishes an expired session. */
async function denyRoleMutation(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  return platformOwnerRequiredResponse(); // PLATFORM_OWNER_REQUIRED
}
export async function PATCH(req: Request) { return denyRoleMutation(req); }
