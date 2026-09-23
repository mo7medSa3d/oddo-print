import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { db } from "../../../../db";
import { emailVerificationTokens, tenantUsers, tenants, users } from "../../../../db/schema";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { hashToken } from "../../../../lib/password";
import { nanoid } from "../../../../lib/nanoid";
import { issueCustomerSession, customerSessionCookie } from "../../../../lib/customer-auth";
import { writeAuditEvent } from "../../../../lib/audit";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { token?: unknown }; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length > 256) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  const tokenHash = await hashToken(token);
  const row = await db.query.emailVerificationTokens.findFirst({
    where: and(
      eq(emailVerificationTokens.tokenHash, tokenHash),
      isNull(emailVerificationTokens.consumedAt),
      gt(emailVerificationTokens.expiresAt, sql`clock_timestamp()`),
    ),
  });
  if (!row) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId), columns: { id: true, emailVerifiedAt: true, email: true } });
  if (!user) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  let tenantId: string;
  let role: any = "owner";
  try {
    await db.transaction(async (tx) => {
      // Serialize all verification flows for this user before deciding whether
      // an initial workspace already exists.
      const lockedUser = await tx.execute(sql`
        SELECT id, email, email_verified_at AS "emailVerifiedAt"
        FROM users
        WHERE id = ${user.id}
        FOR UPDATE
      `);
      const currentUser = lockedUser.rows[0] as { id?: string; email?: string; emailVerifiedAt?: Date | string | null } | undefined;
      if (!currentUser?.id || !currentUser.email) throw new Error("USER_NOT_FOUND");

      const consumed = await tx.update(emailVerificationTokens)
        .set({ consumedAt: sql`now()` })
        .where(and(
          eq(emailVerificationTokens.id, row.id),
          isNull(emailVerificationTokens.consumedAt),
          gt(emailVerificationTokens.expiresAt, sql`clock_timestamp()`),
        ))
        .returning({ id: emailVerificationTokens.id });
      if (consumed.length !== 1) throw new Error("Verification token already consumed");

      await tx.update(users)
        .set({ emailVerifiedAt: sql`COALESCE(email_verified_at, clock_timestamp())`, updatedAt: sql`now()` })
        .where(eq(users.id, currentUser.id));

      const existing = await tx.select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role })
        .from(tenantUsers)
        .where(eq(tenantUsers.userId, currentUser.id))
        .limit(1);
      if (existing[0]) {
        tenantId = existing[0].tenantId;
        role = existing[0].role;
      } else {
        tenantId = `ten_${nanoid(18)}`;
        await tx.insert(tenants).values({ id: tenantId, name: `${currentUser.email.split("@")[0]}'s Workspace` });
        await tx.insert(tenantUsers).values({ userId: currentUser.id, tenantId, role: "owner" });
      }

      await writeAuditEvent({
        tenantId,
        actorType: "user",
        actorId: currentUser.id,
        action: "user.email_verified",
      }, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Verification token already consumed") return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
    if (error instanceof Error && error.message === "USER_NOT_FOUND") return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
    throw error;
  }
  const session = await issueCustomerSession(user.id, tenantId!, role);
  if (!session) {
    return NextResponse.json({ error: "Workspace is unavailable" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, next: "/onboarding" }, { headers: { "Set-Cookie": customerSessionCookie(session) } });
}
