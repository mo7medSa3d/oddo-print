import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { tenantInvitations, tenantUsers, users } from "../../../../../db/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { hashToken, normalizeEmail } from "../../../../../lib/password";
import { writeAuditEvent } from "../../../../../lib/audit";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { clientIpFrom, reserveAuthAttempt, setRateLimitHeaders } from "../../../../../lib/auth-rate-limit";
import { logError } from "../../../../../lib/log";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { token?: unknown; email?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!token || token.length > 256 || !email) return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400 });

  // Token-guessing throttle (mirrors reset-password/verify-email): no account
  // identity is known pre-token, so scope by endpoint + IP. Accepting an
  // invitation mints no session, so the budget is never cleared on success.
  const ip = clientIpFrom(req);
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, "invitation-token");
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "invitation_accept", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 });
  }
  if (!rate.allowed) {
    const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfterSec));
    return setRateLimitHeaders(res, rate);
  }

  const row = await db.query.tenantInvitations.findFirst({
    where: and(eq(tenantInvitations.tokenHash, await hashToken(token)), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt), gt(tenantInvitations.expiresAt, sql`clock_timestamp()`)),
  });
  if (!row || row.email !== email) return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400 });
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
  if (!user) return NextResponse.json({ error: "Create an account with the invited email before accepting the invitation" }, { status: 409 });

  try {
    await db.transaction(async (tx) => {
      const tenant = await tx.execute(sql`
        SELECT id, lifecycle
        FROM tenants
        WHERE id = ${row.tenantId}
        FOR UPDATE
      `);
      const tenantRow = tenant.rows[0] as { id?: string; lifecycle?: string } | undefined;
      if (!tenantRow?.id) throw new Error("TENANT_NOT_FOUND");
      if (tenantRow.lifecycle !== "active") throw new Error("TENANT_NOT_ACTIVE");

      const existingMembership = await tx.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.userId, user.id), eq(tenantUsers.tenantId, row.tenantId)),
        columns: { userId: true },
      });
      if (existingMembership) throw new Error("USER_ALREADY_MEMBER");

      const consumed = await tx.update(tenantInvitations).set({ acceptedAt: sql`now()` })
        .where(and(
          eq(tenantInvitations.id, row.id),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
          gt(tenantInvitations.expiresAt, sql`clock_timestamp()`),
        ))
        .returning({ id: tenantInvitations.id });
      if (consumed.length !== 1) throw new Error("Invitation already consumed or expired");

      const membership = await tx.insert(tenantUsers)
        .values({ userId: user.id, tenantId: row.tenantId, role: row.role })
        .onConflictDoNothing()
        .returning({ userId: tenantUsers.userId });
      if (membership.length !== 1) throw new Error("USER_ALREADY_MEMBER");

      await writeAuditEvent({
        tenantId: row.tenantId,
        actorType: "user",
        actorId: user.id,
        action: "team.invitation.accepted",
        resourceType: "tenant_invitation",
        resourceId: row.id,
      }, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TENANT_NOT_ACTIVE") {
      return NextResponse.json({ error: "Workspace is suspended or unavailable" }, { status: 409 });
    }
    if (error instanceof Error && error.message === "TENANT_NOT_FOUND") {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "USER_ALREADY_MEMBER") {
      return NextResponse.json({ error: "User is already a member of this workspace" }, { status: 409 });
    }
    return NextResponse.json({
      error: error instanceof Error && error.message === "Invitation already consumed"
        ? "Invitation is already used"
        : "Invitation could not be accepted",
    }, { status: 409 });
  }
  return setRateLimitHeaders(NextResponse.json({ ok: true, tenantId: row.tenantId }), rate);
}
