import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { generateOpaqueToken, hashPassword, hashToken, normalizeEmail, validEmail } from "../../../../lib/password";
import { emailVerificationTokens } from "../../../../db/schema";
import { nanoid } from "../../../../lib/nanoid";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { clientIpFrom, reserveAuthAttempt } from "../../../../lib/auth-rate-limit";

const GENERIC = { ok: true, message: "If the account can be created, a verification email will be sent." };

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { email?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!validEmail(email) || password.length < 12 || password.length > 4096) return NextResponse.json({ error: "Enter a valid email and a password of at least 12 characters." }, { status: 400 });
  const ip = clientIpFrom(req);
  const rate = await reserveAuthAttempt(ip, email);
  if (!rate.allowed) { const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return res; }
  const existing = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email), columns: { id: true, emailVerifiedAt: true } });
  if (existing) return NextResponse.json(GENERIC, { status: 202 });
  const userId = `usr_${nanoid(18)}`;
  const rawToken = generateOpaqueToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60_000);
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch {
    return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
  }
  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, email, passwordHash });
      await tx.insert(emailVerificationTokens).values({ id: `evt_${nanoid(18)}`, userId, tokenHash: await hashToken(rawToken), expiresAt });
    });
  } catch (error) {
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) return NextResponse.json(GENERIC, { status: 202 });
    return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
  }

  try {
    const url = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(rawToken)}`;
    await sendTransactionalEmail({
      to: email,
      subject: "Verify your Yasser account",
      html: `<p>Verify your Yasser account.</p><p><a href="${url}">Verify email</a></p><p>This link expires in 30 minutes.</p>`,
      text: `Verify your Yasser account: ${url}\nThis link expires in 30 minutes.`,
    });
  } catch {
    
  }
  // Registration success must not clear the authentication limiter; otherwise
  // an attacker could recycle the limiter with disposable account creations.
  return NextResponse.json(GENERIC, { status: 202 });
}
