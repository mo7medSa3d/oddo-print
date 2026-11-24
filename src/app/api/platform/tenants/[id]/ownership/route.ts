import { hasBodyOverLimit } from "../../../../../../lib/request-limits";
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

/** Owner is informational; only Platform Owner may change the protected marker. */
export async function POST(req: Request, ctx: Ctx) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large", code: "INVALID_REQUEST" }, { status: 413, headers: { "Cache-Control": "private, no-store" } });
  try {
    assertPlatformTeamOrigin(req);
    const claims = await requirePlatformOwner(req);
    const { id: tenantId } = await ctx.params;
    const body: unknown = await req.json().catch(() => null);
    const userId = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { userId?: unknown }).userId : null;
    if (typeof userId !== "string" || !userId) throw new ManualSubscriptionError("MEMBER_ID_REQUIRED", 400);
    await db.transaction(async tx => {
      const tenant = await tx.execute(sql`SELECT id,lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
      if (tenant.rows[0]?.lifecycle !== "active") throw new ManualSubscriptionError("WORKSPACE_NOT_ACTIVE", 409);
      await requirePlatformActorInTransaction(tx, claims);
      const rows = await tx.execute(sql`SELECT user_id,role FROM tenant_users
        WHERE tenant_id=${tenantId} ORDER BY user_id FOR UPDATE`);
      const current = rows.rows.find(row => row.role === "owner");
      const candidate = rows.rows.find(row => row.user_id === userId);
      if (!current || !candidate || current.user_id === userId) throw new ManualSubscriptionError("OWNERSHIP_CONFLICT", 409);
      const demoted = await tx.update(tenantUsers).set({role:"admin",updatedAt:sql`clock_timestamp()`})
        .where(and(eq(tenantUsers.tenantId, tenantId),eq(tenantUsers.userId, String(current.user_id)),eq(tenantUsers.role,"owner")))
        .returning({userId:tenantUsers.userId});
      if (demoted.length !== 1) throw new ManualSubscriptionError("OWNERSHIP_CONFLICT", 409);
      const promoted = await tx.update(tenantUsers).set({role:"owner",updatedAt:sql`clock_timestamp()`})
        .where(and(eq(tenantUsers.tenantId, tenantId),eq(tenantUsers.userId, userId),eq(tenantUsers.role,String(candidate.role))))
        .returning({userId:tenantUsers.userId});
      if (promoted.length !== 1) throw new ManualSubscriptionError("OWNERSHIP_CONFLICT", 409);
      await revokeUserTenantRefreshFamiliesInTransaction(tx, String(current.user_id), tenantId, "ownership_transferred");
      await revokeUserTenantRefreshFamiliesInTransaction(tx, userId, tenantId, "ownership_transferred");
      await writeAuditEvent({
        tenantId, actorType:"platform", actorId:claims.userId,
        action:"team.ownership.transferred", resourceType:"user", resourceId:userId,
      },tx);
    });
    return NextResponse.json({ok:true},{headers:{"Cache-Control":"private, no-store"}});
  } catch (error) { return manualApiError(error); }
}
