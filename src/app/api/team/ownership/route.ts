import { NextResponse } from "next/server";
import { clearCustomerRefreshCookie, clearCustomerSessionCookie } from "../../../../lib/customer-auth";
import { db } from "../../../../db";
import { tenantUsers } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  clearManagerCookieHeader,
  clearManagerRefreshCookieHeader,
  validateWorkspaceManager,
  revokeLegacyManagerSessionsForUserInTransaction,
} from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { writeAuditEvent } from "../../../../lib/audit";
import { revokeUserTenantRefreshFamiliesInTransaction } from "../../../../lib/session-tokens";

class OwnershipConflict extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
  }
}

export async function POST(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId || claims.role !== "owner" || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Only the workspace owner can transfer ownership" }, { status: 403 });
  const currentUserId = claims.userId;
  let body: { userId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const newOwnerId = typeof body.userId === "string" ? body.userId : "";
  if (!newOwnerId || newOwnerId === currentUserId) return NextResponse.json({ error: "A different member is required" }, { status: 400 });

  try {
    await db.transaction(async (tx) => {
      // Lock both membership rows in a deterministic user-id order. This
      // serializes transfers with role changes and deletions on the same rows.
      const locked = await tx.execute(sql`
        SELECT user_id, role
        FROM tenant_users
        WHERE tenant_id = ${claims.tenantId}
          AND (user_id = ${currentUserId} OR user_id = ${newOwnerId})
        ORDER BY user_id
        FOR UPDATE
      `);
      const rows = locked.rows as Array<{ user_id: string; role: string }>;
      const current = rows.find((row) => row.user_id === currentUserId);
      const target = rows.find((row) => row.user_id === newOwnerId);
      if (!target) throw new OwnershipConflict("Target member is not in this workspace");
      if (!current || current.role !== "owner") throw new OwnershipConflict("Ownership has already changed. Refresh and try again.");
      if (target.role === "owner") throw new OwnershipConflict("Target member is already an owner; refresh and try again.");

      const demoted = await tx.update(tenantUsers)
        .set({ role: "admin", updatedAt: sql`now()` })
        .where(and(
          eq(tenantUsers.tenantId, claims.tenantId),
          eq(tenantUsers.userId, currentUserId),
          eq(tenantUsers.role, "owner"),
        ))
        .returning({ userId: tenantUsers.userId });
      if (demoted.length !== 1) throw new OwnershipConflict("Ownership has already changed. Refresh and try again.");

      const promoted = await tx.update(tenantUsers)
        .set({ role: "owner", updatedAt: sql`now()` })
        .where(and(
          eq(tenantUsers.tenantId, claims.tenantId),
          eq(tenantUsers.userId, newOwnerId),
          eq(tenantUsers.role, target.role),
        ))
        .returning({ userId: tenantUsers.userId });
      if (promoted.length !== 1) throw new OwnershipConflict("Target membership changed concurrently; no ownership change was committed.");

      await revokeLegacyManagerSessionsForUserInTransaction(tx, currentUserId, claims.tenantId);
      await revokeUserTenantRefreshFamiliesInTransaction(
        tx,
        currentUserId,
        claims.tenantId,
        "ownership_transferred",
      );

      await writeAuditEvent(
        {
          tenantId: claims.tenantId,
          actorType: "user",
          actorId: currentUserId,
          action: "team.ownership.transferred",
          resourceType: "user",
          resourceId: newOwnerId,
        },
        tx,
      );
    });
  } catch (error) {
    if (error instanceof OwnershipConflict) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const res = NextResponse.json({ ok: true, next: "/login" });
  // Ownership transfer revokes the current user's tenant session family.
  // Clear both web session cookie pairs so the browser cannot keep presenting
  // a revoked manager or workspace session after the transfer.
  res.headers.set("Set-Cookie", clearManagerCookieHeader());
  res.headers.append("Set-Cookie", clearManagerRefreshCookieHeader());
  res.headers.append("Set-Cookie", clearCustomerSessionCookie());
  res.headers.append("Set-Cookie", clearCustomerRefreshCookie());
  res.headers.set("Cache-Control", "no-store");
  return res;
}