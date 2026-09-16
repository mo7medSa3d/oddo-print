import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { db } from "../../../../db";
import { emailVerificationTokens, tenantUsers, tenants, users } from "../../../../db/schema";
import { and, eq, isNull, gt } from "drizzle-orm";
import { hashToken } from "../../../../lib/password";
import { nanoid } from "../../../../lib/nanoid";
import { issueCustomerSession, customerSessionCookie } from "../../../../lib/customer-auth";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { token?: unknown }; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length > 256) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  const now = new Date();
  const tokenHash = await hashToken(token);
  const row = await db.query.emailVerificationTokens.findFirst({ where: and(eq(emailVerificationTokens.tokenHash, tokenHash), isNull(emailVerificationTokens.consumedAt), gt(emailVerificationTokens.expiresAt, now)) });
  if (!row) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId), columns: { id: true, emailVerifiedAt: true, email: true } });
  if (!user) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  let tenantId: string;
  let role: any = "owner";
  try {
    await db.transaction(async (tx) => {
      const consumed = await tx.update(emailVerificationTokens).set({ consumedAt: now }).where(and(eq(emailVerificationTokens.id, row.id), isNull(emailVerificationTokens.consumedAt))).returning({ id: emailVerificationTokens.id });
      if (consumed.length !== 1) throw new Error("Verification token already consumed");
      await tx.update(users).set({ emailVerifiedAt: user.emailVerifiedAt ?? now, updatedAt: now }).where(eq(users.id, user.id));
      const existing = await tx.select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role }).from(tenantUsers).where(eq(tenantUsers.userId, user.id)).limit(1);
      if (existing[0]) { tenantId = existing[0].tenantId; role = existing[0].role; return; }
      tenantId = `ten_${nanoid(18)}`;
      await tx.insert(tenants).values({ id: tenantId, name: `${user.email.split("@")[0]}'s Workspace` });
      await tx.insert(tenantUsers).values({ userId: user.id, tenantId, role: "owner" });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Verification token already consumed") return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
    throw error;
  }
  const session = await issueCustomerSession(user.id, tenantId!, role);
  await import("../../../../lib/audit").then(({ writeAuditEvent }) => writeAuditEvent({ tenantId: tenantId!, actorType: "user", actorId: user.id, action: "user.email_verified" })).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  return NextResponse.json({ ok: true, next: "/onboarding" }, { headers: { "Set-Cookie": customerSessionCookie(session) } });
}
