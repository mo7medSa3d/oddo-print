import { NextResponse } from "next/server";
import { db } from "../../../../../../db";
import { tenantUsers } from "../../../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { requirePlatformOwner, requirePlatformActorInTransaction } from "../../../../../../lib/platform-auth";
import { assertPlatformTeamOrigin } from "../../../../../../lib/platform-team-security";
import { ManualSubscriptionError } from "../../../../../../lib/manual-subscriptions";
import { manualApiError } from "../../../../../../lib/manual-api-error";
import { revokeUserTenantRefreshFamiliesInTransaction } from "../../../../../../lib/session-tokens";
import { writeAuditEvent } from "../../../../../../lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** Deletion is per-workspace, never global account deletion. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    assertPlatformTeamOrigin(req);
    const claims = await requirePlatformOwner(req);
    const { id: tenantId } = await ctx.params;
    const userId = new URL(req.url).searchParams.get("userId") ?? "";
    if (!userId) throw new ManualSubscriptionError("MEMBER_ID_REQUIRED", 400);
    await db.transaction(async tx => {
      const tenant = await tx.execute(sql`SELECT id FROM tenants WHERE id=${tenantId} FOR UPDATE`);
      if (!tenant.rows.length) throw new ManualSubscriptionError("WORKSPACE_NOT_FOUND", 404);
      await requirePlatformActorInTransaction(tx, claims);
      const target = await tx.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
        columns: { role: true },
      });
      if (!target) throw new ManualSubscriptionError("MEMBER_NOT_FOUND", 404);
      if (target.role === "owner") throw new ManualSubscriptionError("TRANSFER_OWNER_FIRST", 409);
      const removed = await tx.delete(tenantUsers).where(and(
        eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId), eq(tenantUsers.role, target.role),
      )).returning({ userId: tenantUsers.userId });
      if (removed.length !== 1) throw new ManualSubscriptionError("MEMBER_CHANGED", 409);
      await revokeUserTenantRefreshFamiliesInTransaction(tx, userId, tenantId, "platform_member_removed");
      await writeAuditEvent({
        tenantId, actorType: "platform", actorId: claims.userId,
        action: "team.member.removed", resourceType: "user", resourceId: userId,
      }, tx);
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return manualApiError(error); }
}
