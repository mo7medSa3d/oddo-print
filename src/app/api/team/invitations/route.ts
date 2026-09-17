import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantInvitations, users } from "../../../../db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { generateOpaqueToken, hashToken, normalizeEmail } from "../../../../lib/password";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { nanoid } from "../../../../lib/nanoid";
import { writeAuditEvent } from "../../../../lib/audit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

const ROLES = ["admin", "operator", "viewer", "integration_admin", "billing_admin"] as const;

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await db.select({ id: tenantInvitations.id, email: tenantInvitations.email, role: tenantInvitations.role, expiresAt: tenantInvitations.expiresAt, createdAt: tenantInvitations.createdAt })
    .from(tenantInvitations).where(and(eq(tenantInvitations.tenantId, claims.tenantId), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt), gt(tenantInvitations.expiresAt, new Date())));
  return NextResponse.json({ invitations: rows });
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { email?: unknown; role?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const role = typeof body.role === "string" ? body.role : "viewer";
  if (!email || !ROLES.includes(role as (typeof ROLES)[number])) return NextResponse.json({ error: "Invalid invitation" }, { status: 400 });
  const member = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
  if (member) {
    const existing = await db.query.tenantInvitations.findFirst({ where: and(eq(tenantInvitations.tenantId, claims.tenantId), eq(tenantInvitations.email, email), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt), gt(tenantInvitations.expiresAt, new Date())), columns: { id: true } });
    if (existing) return NextResponse.json({ error: "An active invitation already exists for this email" }, { status: 409 });
  }
  const raw = generateOpaqueToken();
  const id = `inv_${nanoid(18)}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  await db.insert(tenantInvitations).values({ id, tenantId: claims.tenantId, inviterUserId: claims.userId, email, role, tokenHash: await hashToken(raw), expiresAt });
  const url = `${appBaseUrl(req)}/invite?token=${encodeURIComponent(raw)}`;
  try {
    await sendTransactionalEmail({ to: email, subject: "You are invited to Print Gateway", html: `<p>You have been invited to a Print Gateway workspace.</p><p><a href="${url}">Accept invitation</a></p>`, text: `Accept invitation: ${url}` });
  } catch {
    await db.update(tenantInvitations).set({ revokedAt: new Date() }).where(eq(tenantInvitations.id, id));
    return NextResponse.json({ error: "Invitation delivery is temporarily unavailable" }, { status: 503 });
  }
  await writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: claims.userId, action: "team.invitation.created", resourceType: "tenant_invitation", resourceId: id }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    await db.transaction(async (tx) => {
      const result = await tx.update(tenantInvitations).set({ revokedAt: new Date() }).where(and(eq(tenantInvitations.id, id), eq(tenantInvitations.tenantId, claims.tenantId), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt))).returning({ id: tenantInvitations.id });
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
