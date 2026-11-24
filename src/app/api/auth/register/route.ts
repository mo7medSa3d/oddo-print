import { logError } from "../../../../lib/log";
import { after, NextResponse } from "next/server";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { generateOpaqueToken, hashPassword, hashToken, normalizeEmail, validEmail } from "../../../../lib/password";
import { emailVerificationTokens } from "../../../../db/schema";
import { nanoid } from "../../../../lib/nanoid";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { getServerLocale, makeT } from "../../../../i18n/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { clientIpFrom, reserveScopedAuthAttempt, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { emailAuthTokenTimes } from "../../../../lib/email-auth-token-policy";
import { findActiveInvitation } from "../../../../lib/invitation-join";

const GENERIC = { ok: true, message: "If the account can be created, a verification email will be sent." };

export async function POST(req: Request) {
  const t = makeT(await getServerLocale());
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { email?: unknown; password?: unknown; planId?: unknown; inviteToken?: unknown; displayName?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const planId = typeof body.planId === "string" && body.planId.length <= 128 ? body.planId : "";
  if (body.inviteToken !== undefined && (typeof body.inviteToken !== "string" || body.inviteToken.length > 256))
    return NextResponse.json({ error: "Invitation is invalid or expired", code: "INVITATION_INVALID" }, { status: 400 });
  const inviteToken = typeof body.inviteToken === "string" && body.inviteToken.length <= 256 ? body.inviteToken : "";
  if (!validEmail(email)) return NextResponse.json({ error: "Enter a valid email address.", code: "INVALID_INPUT" }, { status: 400 });
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName)) return NextResponse.json({ error: "Invalid name", code: "INVALID_INPUT" }, { status: 400 });
  const ip = clientIpFrom(req);
  let rate: Awaited<ReturnType<typeof reserveScopedAuthAttempt>>;
  try {
    rate = await reserveScopedAuthAttempt(ip, "register", email);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "register", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
  }
  if (!rate.allowed) { const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return setRateLimitHeaders(res, rate); }
  // Compatibility for older invitation links that still navigate via
  // /signup: bind the verified address to the invitation on the SERVER.
  // Never create a default owner workspace because the browser dropped a
  // query parameter on a later verification step.
  const invitation = inviteToken ? await findActiveInvitation(inviteToken) : null;
  if (inviteToken && (!invitation || invitation.email !== email))
    return setRateLimitHeaders(NextResponse.json({ error: "Invitation expired or for a different email", code: "INVITATION_INVALID" }, { status: 400 }), rate);
  // No user-chosen password is accepted before mailbox ownership is proven.
  // Persist only a random, unusable provisional password. Preserve equivalent
  // KDF cost for existing/new addresses to limit registration enumeration.
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(generateOpaqueToken());
  } catch {
    return setRateLimitHeaders(NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 }), rate);
  }
  const existing = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email), columns: { id: true, emailVerifiedAt: true } });
  if (existing) return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
  const userId = `usr_${nanoid(18)}`;
  const rawToken = generateOpaqueToken();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, email, passwordHash, displayName: displayName || null });
      await tx.insert(emailVerificationTokens).values({ id: `evt_${nanoid(18)}`, userId, tokenHash: await hashToken(rawToken), invitationId: invitation?.id ?? null, ...emailAuthTokenTimes() });
    });
  } catch (error) {
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
    return setRateLimitHeaders(NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 }), rate);
  }

  // Delivery latency/retries must not disclose whether the address was new.
  // Next's tracked after() lifecycle is drained by the custom server on
  // graceful shutdown. This is not a durable outbox: resend-verification
  // remains the recovery path after an abrupt crash or provider outage.
  after(async () => {
    try {
      const planQuery = planId ? `&plan=${encodeURIComponent(planId)}` : "";
      const inviteQuery = inviteToken ? `&invite=${encodeURIComponent(inviteToken)}` : "";
      const url = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(rawToken)}${planQuery}${inviteQuery}`;
      await sendTransactionalEmail({
        to: email,
        subject: t("mail.verify.subject"),
        html: `<p>${t("mail.verify.body")}</p><p><a href="${url}">${t("mail.verify.cta")}</a></p><p>${t("mail.verify.expires")}</p>`,
        text: t("mail.verify.text", { url }),
      });
    } catch (error) {
      // Registration is committed and the generic 202 response is required
      // (email outages must not fail signup or leak account state), but the
      // failure must not be invisible: the verification token exists while the
      // mailbox never receives the link. Log it so operators can act; the
      // user-facing recovery path is /api/auth/resend-verification.
      logError("auth.register.verification_email_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
  // Registration success must not clear the authentication limiter; otherwise
  // an attacker could recycle the limiter with disposable account creations.
  return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
}
