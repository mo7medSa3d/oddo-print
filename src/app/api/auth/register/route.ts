import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { generateOpaqueToken, hashPassword, hashToken, normalizeEmail, validEmail } from "../../../../lib/password";
import { emailVerificationTokens } from "../../../../db/schema";
import { nanoid } from "../../../../lib/nanoid";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { clientIpFrom, reserveAuthAttempt, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { sql } from "drizzle-orm";

const GENERIC = { ok: true, message: "If the account can be created, a verification email will be sent." };

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { email?: unknown; password?: unknown; planId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body.password === "string" ? body.password : "";
  const planId = typeof body.planId === "string" && body.planId.length <= 128 ? body.planId : "";
  if (!validEmail(email) || password.length < 12 || password.length > 4096) return NextResponse.json({ error: "Enter a valid email and a password of at least 12 characters." }, { status: 400 });
  const ip = clientIpFrom(req);
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, email);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "register", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
  }
  if (!rate.allowed) { const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return setRateLimitHeaders(res, rate); }
  const existing = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email), columns: { id: true, emailVerifiedAt: true } });
  if (existing) return setRateLimitHeaders(NextResponse.json({ error: "An account with this email already exists. You can sign in instead.", code: "ACCOUNT_EXISTS" }, { status: 409 }), rate);
  const userId = `usr_${nanoid(18)}`;
  const rawToken = generateOpaqueToken();
  const expiresAt = sql`clock_timestamp() + interval '30 minutes'`;
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch {
    return setRateLimitHeaders(NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 }), rate);
  }
  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, email, passwordHash });
      await tx.insert(emailVerificationTokens).values({ id: `evt_${nanoid(18)}`, userId, tokenHash: await hashToken(rawToken), expiresAt });
    });
  } catch (error) {
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
    return setRateLimitHeaders(NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 }), rate);
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
  } catch (error) {
    // Registration is committed and the generic 202 response is required
    // (email outages must not fail signup or leak account state), but the
    // failure must not be invisible: the verification token exists while the
    // mailbox never receives the link. Log it so operators can act; the
    // user-facing recovery path is /api/auth/resend-verification.
    logError("auth.register.verification_email_failed", { error: error instanceof Error ? error.message : String(error) });
  }
  // Registration success must not clear the authentication limiter; otherwise
  // an attacker could recycle the limiter with disposable account creations.
  return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
}
