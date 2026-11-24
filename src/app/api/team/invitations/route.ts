import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantInvitations } from "../../../../db/schema";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { requireActiveTenantInTransaction } from "../../../../lib/tenant-guard";
import { queryWithTimeout } from "../../../../db/client";
import { clampListLimit, parseStrictListOffset } from "../../../../lib/request-limits";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { requireWorkspaceOwnerForInvites } from "../../../../lib/workspace-owner-invitations";
import { assertPlatformTeamOrigin } from "../../../../lib/platform-team-security";
import { ManualSubscriptionError } from "../../../../lib/manual-subscriptions";
import { manualApiError } from "../../../../lib/manual-api-error";
import { generateOpaqueToken, hashToken, normalizeEmail, validEmail } from "../../../../lib/password";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { getServerLocale, makeT } from "../../../../i18n/server";
import { nanoid } from "../../../../lib/nanoid";
import { writeAuditEvent } from "../../../../lib/audit";
import { logError } from "../../../../lib/log";

/** Workspace-scoped pending invitations, without revealing any invitation token. */
export async function GET(req: Request) {
  try {
    const claims = await validateWorkspaceManager(req);
    if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    if (!hasManagerPermission(claims, "users.read")) {
      return NextResponse.json({ error: "Forbidden", code: "FORBIDDEN" }, { status: 403 });
    }
    const { searchParams } = new URL(req.url);
    const limit = clampListLimit(searchParams.get("limit"), 50, 100);
    const offset = parseStrictListOffset(searchParams.get("offset"), 1_000_000);
    if (offset === null) {
      return NextResponse.json({ error: "Invalid offset", code: "INVALID_OFFSET" }, { status: 400 });
    }
    const visible = and(
      eq(tenantInvitations.tenantId, claims.tenantId),
      isNull(tenantInvitations.acceptedAt),
      isNull(tenantInvitations.revokedAt),
      gt(tenantInvitations.expiresAt, sql`clock_timestamp()`),
    );
    // Recheck the live owner and session while holding the same database snapshot as the read.
    const [rows, countRows] = await db.transaction(async tx => {
      // Tenant lifecycle must be fenced BEFORE the owner/session read.
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireWorkspaceOwnerForInvites(tx, claims);
      return Promise.all([
      queryWithTimeout(() => tx.select({
        id: tenantInvitations.id, email: tenantInvitations.email,
        expiresAt: tenantInvitations.expiresAt, createdAt: tenantInvitations.createdAt,
      }).from(tenantInvitations).where(visible)
        .orderBy(desc(tenantInvitations.createdAt), desc(tenantInvitations.id))
        .offset(offset).limit(limit + 1), 5_000, "teamInvitationsList"),
      queryWithTimeout(() => tx.select({ total: sql<number>`count(*)::int` })
        .from(tenantInvitations).where(visible), 5_000, "teamInvitationsCount"),
      ]);
    });
    return NextResponse.json({
      invitations: rows.slice(0, limit), hasMore: rows.length > limit,
      offset, limit, total: countRows[0]?.total ?? 0,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return manualApiError(error); }
}

const active = (tenantId: string, email?: string) => and(
  eq(tenantInvitations.tenantId, tenantId),
  isNull(tenantInvitations.acceptedAt),
  isNull(tenantInvitations.revokedAt),
  gt(tenantInvitations.expiresAt, sql`clock_timestamp()`),
  ...(email ? [eq(tenantInvitations.email, email)] : []),
);

/** A valid workspace cookie plus a currently verified workspace owner identity
 * authorizes only this tenant's invitation creation, with no password prompt.
 * Platform subscription/member/ownership APIs keep their separate authority. */
export async function POST(req: Request) {
  try {
    assertPlatformTeamOrigin(req);
    if (hasBodyOverLimit(req, 16 * 1024)) throw new ManualSubscriptionError("REQUEST_TOO_LARGE", 413);
    const claims = await validateWorkspaceManager(req);
    if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ManualSubscriptionError("INVALID_JSON", 400);
    const fields = body as Record<string, unknown>;
    if ("role" in fields) throw new ManualSubscriptionError("ROLE_SELECTION_RETIRED", 400);
    if (Object.keys(fields).some(key => key !== "email")) throw new ManualSubscriptionError("INVALID_REQUEST", 400);
    const email = typeof fields.email === "string" ? normalizeEmail(fields.email) : "";
    if (!validEmail(email)) throw new ManualSubscriptionError("INVALID_EMAIL", 400);
    const inviteId = `inv_${nanoid(18)}`;
    const token = generateOpaqueToken();
    await db.transaction(async tx => {
      const tenant = await tx.execute(sql`SELECT id,lifecycle FROM tenants WHERE id=${claims.tenantId} FOR UPDATE`);
      if (tenant.rows[0]?.lifecycle !== "active") throw new ManualSubscriptionError("WORKSPACE_NOT_ACTIVE", 409);
      await requireWorkspaceOwnerForInvites(tx, claims);
      const pending = await tx.query.tenantInvitations.findFirst({
        where: active(claims.tenantId, email), columns: { id: true },
      });
      if (pending) throw new ManualSubscriptionError("INVITATION_ALREADY_EXISTS", 409);
      const existing = await tx.execute(sql`SELECT 1 FROM tenant_users m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${claims.tenantId} AND u.email=${email} LIMIT 1`);
      if (existing.rows.length) throw new ManualSubscriptionError("ALREADY_MEMBER", 409);
      await tx.insert(tenantInvitations).values({
        id: inviteId, tenantId: claims.tenantId, inviterUserId: claims.userId!,
        email, role: "admin", tokenHash: await hashToken(token),
        expiresAt: sql`clock_timestamp() + interval '7 days'`,
      });
      await writeAuditEvent({
        tenantId: claims.tenantId, actorType: "user", actorId: claims.userId,
        action: "team.invitation.created", resourceType: "tenant_invitation", resourceId: inviteId,
      }, tx);
    });
    try {
      const t = makeT(await getServerLocale());
      const url = `${appBaseUrl(req)}/invite?token=${encodeURIComponent(token)}`;
      await sendTransactionalEmail({
        to: email, subject: t("mail.invite.subject"),
        html: `<p>${t("mail.invite.body")}</p><p><a href="${url}">${t("mail.invite.cta")}</a></p>`,
        text: t("mail.invite.text", { url }),
      });
    } catch (error) {
      logError("team.invitation_delivery_ambiguous", { error: error instanceof Error ? error.message : "unknown" });
      return NextResponse.json({ error: "Invitation created; delivery unconfirmed", code: "INVITATION_DELIVERY_UNAVAILABLE", id: inviteId }, { status: 503 });
    }
    return NextResponse.json({ ok: true, id: inviteId }, { status: 201 });
  } catch (error) { return manualApiError(error); }
}

export async function DELETE(req: Request) {
  try {
    assertPlatformTeamOrigin(req);
    const claims = await validateWorkspaceManager(req);
    if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!id || id.length > 128) throw new ManualSubscriptionError("INVITATION_ID_REQUIRED", 400);
    await db.transaction(async tx => {
      const tenant = await tx.execute(sql`SELECT id FROM tenants WHERE id=${claims.tenantId} FOR UPDATE`);
      if (!tenant.rows.length) throw new ManualSubscriptionError("WORKSPACE_NOT_FOUND", 404);
      await requireWorkspaceOwnerForInvites(tx, claims);
      const revoked = await tx.update(tenantInvitations)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(and(
          eq(tenantInvitations.id, id), eq(tenantInvitations.tenantId, claims.tenantId),
          isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt),
        )).returning({ id: tenantInvitations.id });
      if (revoked.length !== 1) throw new ManualSubscriptionError("INVITATION_NOT_FOUND", 404);
      await writeAuditEvent({
        tenantId: claims.tenantId, actorType: "user", actorId: claims.userId,
        action: "team.invitation.revoked", resourceType: "tenant_invitation", resourceId: id,
      }, tx);
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return manualApiError(error); }
}
