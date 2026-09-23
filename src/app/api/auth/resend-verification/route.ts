import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { users, emailVerificationTokens } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateOpaqueToken, hashToken, normalizeEmail, validEmail } from "../../../../lib/password";
import { nanoid } from "../../../../lib/nanoid";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { clientIpFrom, reserveAuthAttempt } from "../../../../lib/auth-rate-limit";

const GENERIC = { ok: true, message: "If the account exists and is unverified, a new verification link has been sent." };

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 64 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { email?: unknown; planId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const planId = typeof body.planId === "string" && body.planId.length <= 128 ? body.planId : "";
  if (!validEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const ip = clientIpFrom(req);
  const rate = await reserveAuthAttempt(ip, email);
  if (!rate.allowed) {
    const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfterSec));
    return res;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, emailVerifiedAt: true },
  });

  if (!user || user.emailVerifiedAt) {
    return NextResponse.json(GENERIC, { status: 202 });
  }

  const rawToken = generateOpaqueToken();
  const tokenHash = await hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60_000);

  try {
    const persisted = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, email_verified_at AS "emailVerifiedAt"
        FROM users
        WHERE id = ${user.id}
        FOR UPDATE
      `);
      const lockedRow = locked.rows[0] as { id?: string; emailVerifiedAt?: Date | string | null } | undefined;
      if (!lockedRow?.id || lockedRow.emailVerifiedAt) return false;

      await tx
        .update(emailVerificationTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(emailVerificationTokens.userId, user.id),
            isNull(emailVerificationTokens.consumedAt)
          )
        );

      await tx.insert(emailVerificationTokens).values({
        id: `evt_${nanoid(18)}`,
        userId: user.id,
        tokenHash,
        expiresAt,
      });
      return true;
    });
    if (!persisted) return NextResponse.json(GENERIC, { status: 202 });
  } catch {
    // Keep this endpoint enumeration-safe even when token persistence is
    // temporarily unavailable. No token is sent unless persistence succeeds.
    return NextResponse.json(GENERIC, { status: 202 });
  }

  try {
    const planQuery = planId ? `&plan=${encodeURIComponent(planId)}` : "";
    const url = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(rawToken)}${planQuery}`;
    await sendTransactionalEmail({
      to: email,
      subject: "Verify your Yasser account",
      html: `<p>Verify your Yasser account.</p><p><a href="${url}">Verify email</a></p><p>This link expires in 30 minutes.</p>`,
      text: `Verify your Yasser account: ${url}\nThis link expires in 30 minutes.`,
    });
  } catch {
    // Suppress email delivery error in response to preserve anti-enumeration
  }

  return NextResponse.json(GENERIC, { status: 202 });
}
