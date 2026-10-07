import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantInvitations } from "../../../../db/schema";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { generateOpaqueToken, hashToken, normalizeEmail } from "../../../../lib/password";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { getServerLocale, makeT } from "../../../../i18n/server";
import { nanoid } from "../../../../lib/nanoid";
import { writeAuditEvent } from "../../../../lib/audit";
import { clampListLimit, hasBodyOverLimit } from "../../../../lib/request-limits";
import { logError } from "../../../../lib/log";
import { queryWithTimeout } from "../../../../db/client";

const ROLES = ["admin", "operator", "viewer", "integration_admin", "billing_admin"] as const;

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

  const activeInvitation = and(
    eq(tenantInvitations.tenantId, claims.tenantId),
    isNull(tenantInvitations.acceptedAt),
    isNull(tenantInvitations.revokedAt),
    gt(tenantInvitations.expiresAt, sql`clock_timestamp()`),
  );
  const [rows, countRows] = await Promise.all([
    queryWithTimeout(
      () => db
        .select({
          id: tenantInvitations.id,
          email: tenantInvitations.email,
          role: tenantInvitations.role,
          expiresAt: tenantInvitations.expiresAt,
          createdAt: tenantInvitations.createdAt,
        })
        .from(tenantInvitations)
        .where(activeInvitation)
        .orderBy(desc(tenantInvitations.createdAt), desc(tenantInvitations.id))
        .offset(offset)
        .limit(limit + 1),
      5_000,
      "teamInvitationsList",
    ),
    queryWithTimeout(
      () => db
        .select({ total: sql<number>`count(*)::int` })
        .from(tenantInvitations)
        .where(activeInvitation),
      5_000,
      "teamInvitationsCount",
    ),
  ]);

  return NextResponse.json({
    invitations: rows.slice(0, limit),
    hasMore: rows.length > limit,
    offset,
    limit,
    total: countRows[0]?.total ?? 0,
  });
}

export async function POST(req: Request) {
  const t = makeT(await getServerLocale());
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const inviterUserId = claims.userId;
  let body: { email?: unknown; role?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const role = typeof body.role === "string" ? body.role : "viewer";
  if (!email || !ROLES.includes(role as (typeof ROLES)[number])) return NextResponse.json({ error: "Invalid invitation" }, { status: 400 });
  const raw = generateOpaqueToken();
  const id = `inv_${nanoid(18)}`;
  const expiresAt = sql`clock_timestamp() + interval '7 days'`;
  try {
    await db.transaction(async (tx) => {
      // Lock the tenant row before checking for another active invitation so
      // concurrent invitation requests for the same email cannot both pass the
      // preflight and create duplicate live tokens.
    const tenant = await tx.execute(sql`
      SELECT id, lifecycle
      FROM tenants
      WHERE id = ${claims.tenantId}
      FOR UPDATE
    `);
    const tenantRow = tenant.rows[0] as { id?: string; lifecycle?: string } | undefined;
    if (!tenantRow?.id) throw new Error("TENANT_NOT_FOUND");
    if (tenantRow.lifecycle !== "active") throw new Error("TENANT_NOT_ACTIVE");

    const existing = await tx.query.tenantInvitations.findFirst({
      where: and(
        eq(tenantInvitations.tenantId, claims.tenantId),
        eq(tenantInvitations.email, email),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
        gt(tenantInvitations.expiresAt, sql`clock_timestamp()`),
      ),
      columns: { id: true },
    });
    if (existing) throw new Error("INVITATION_ALREADY_EXISTS");

    await tx.insert(tenantInvitations).values({
      id,
      tenantId: claims.tenantId,
      inviterUserId,
      email,
      role,
      tokenHash: await hashToken(raw),
      expiresAt,
    });
    await writeAuditEvent({
      tenantId: claims.tenantId,
      actorType: "user",
      actorId: inviterUserId,
      action: "team.invitation.created",
      resourceType: "tenant_invitation",
      resourceId: id,
    }, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_ALREADY_EXISTS") {
      return NextResponse.json({ error: "An active invitation already exists for this email" }, { status: 409 });
    }
    if (error instanceof Error && error.message === "TENANT_NOT_ACTIVE") {
      return NextResponse.json({ error: "Workspace is suspended or unavailable" }, { status: 409 });
    }
    if (error instanceof Error && error.message === "TENANT_NOT_FOUND") {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    throw error;
  }
  const url = `${appBaseUrl(req)}/invite?token=${encodeURIComponent(raw)}`;
  try {
    await sendTransactionalEmail({
      to: email,
      subject: t("mail.invite.subject"),
      html: `<p>${t("mail.invite.body")}</p><p><a href="${url}">${t("mail.invite.cta")}</a></p>`,
      text: t("mail.invite.text", { url }),
    });
  } catch (error) {
    // Email delivery is an ambiguous external side effect: a provider timeout
    // or connection reset does not prove that the message was not accepted.
    // Never revoke the durable invitation here, because doing so can invalidate
    // a link that the invitee already received. The invitation remains bounded
    // by its expiry/revocation/acceptance state and can be administratively
    // revoked or replaced later.
    logError("team.invitation_email_delivery_ambiguous", {
      error: error instanceof Error ? error.message : "unknown",
    });
    // The `code` is the contract: the client maps it to a translated message
    // rather than rendering this English string, which is written for logs.
    // Semantically this is NOT "the invitation failed" — the durable row was
    // created above and is deliberately not revoked. Saying "failed" here
    // would tell the operator to send a second invitation when the first
    // link may already be in the invitee's inbox.
    return NextResponse.json(
      { error: "Invitation delivery is temporarily unavailable", code: "INVITATION_DELIVERY_UNAVAILABLE" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    await db.transaction(async (tx) => {
      const result = await tx.update(tenantInvitations).set({ revokedAt: sql`now()` }).where(and(eq(tenantInvitations.id, id), eq(tenantInvitations.tenantId, claims.tenantId), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt))).returning({ id: tenantInvitations.id });
      if (result.length !== 1) throw new Error("INVITATION_NOT_FOUND");
      await writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: claims.userId, action: "team.invitation.revoked", resourceType: "tenant_invitation", resourceId: id }, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_NOT_FOUND") {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }
    throw error;
  }
  return NextResponse.json({ ok: true });
}
