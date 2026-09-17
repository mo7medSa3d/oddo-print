import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { users, emailVerificationTokens } from "../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
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

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
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
    await db.transaction(async (tx) => {
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
    });
  } catch {
    return NextResponse.json({ error: "Resending verification temporarily unavailable" }, { status: 503 });
  }

  try {
    const url = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(rawToken)}`;
    await sendTransactionalEmail({
      to: email,
      subject: "Verify your Print Gateway account",
      html: `<p>Verify your Print Gateway account.</p><p><a href="${url}">Verify email</a></p><p>This link expires in 30 minutes.</p>`,
      text: `Verify your Print Gateway account: ${url}\nThis link expires in 30 minutes.`,
    });
  } catch {
    // Suppress email delivery error in response to preserve anti-enumeration
  }

  return NextResponse.json(GENERIC, { status: 202 });
}
