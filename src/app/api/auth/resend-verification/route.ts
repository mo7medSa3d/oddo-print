import { after, NextResponse } from "next/server";
import { db } from "../../../../db";
import { users, emailVerificationTokens } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateOpaqueToken, hashToken, normalizeEmail, validEmail } from "../../../../lib/password";
import { nanoid } from "../../../../lib/nanoid";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { getServerLocale, makeT } from "../../../../i18n/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { clientIpFrom, reserveScopedAuthAttempt, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { logError } from "../../../../lib/log";
import { findActiveInvitation } from "../../../../lib/invitation-join";
import { emailAuthTokenTimes } from "../../../../lib/email-auth-token-policy";

const GENERIC = { ok: true, message: "If the account exists and is unverified, a new verification link has been sent." };

export async function POST(req: Request) {
  const t = makeT(await getServerLocale());
  if (hasBodyOverLimit(req, 64 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { email?: unknown; planId?: unknown; inviteToken?: unknown };
  try {
    const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const planId = typeof body.planId === "string" && body.planId.length <= 128 ? body.planId : "";
  if (body.inviteToken !== undefined && (typeof body.inviteToken !== "string" || body.inviteToken.length > 256))
    return NextResponse.json({ error: "Invitation is invalid or expired", code: "INVITATION_INVALID" }, { status: 400 });
  const inviteToken = typeof body.inviteToken === "string" && body.inviteToken.length <= 256 ? body.inviteToken : "";
  if (!validEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const ip = clientIpFrom(req);
  let rate: Awaited<ReturnType<typeof reserveScopedAuthAttempt>>;
  try {
    rate = await reserveScopedAuthAttempt(ip, "resend-verification", email);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "resend_verification", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(GENERIC, { status: 503 });
  }
  if (!rate.allowed) {
    const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfterSec));
    return setRateLimitHeaders(res, rate);
  }

  // An invalid continuation must receive the same response regardless of
  // whether this email has an unverified account.
  const invitation = inviteToken ? await findActiveInvitation(inviteToken) : null;
  if (inviteToken && (!invitation || invitation.email !== email))
    return setRateLimitHeaders(NextResponse.json({ error: "Invitation expired or for a different email", code: "INVITATION_INVALID" }, { status: 409 }), rate);

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, emailVerifiedAt: true },
  });

  if (!user || user.emailVerifiedAt) {
    return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
  }
  const rawToken = generateOpaqueToken();
  const tokenHash = await hashToken(rawToken);
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

      const pending = await tx.query.emailVerificationTokens.findFirst({
        where: and(eq(emailVerificationTokens.userId, user.id),
          isNull(emailVerificationTokens.consumedAt)),
        columns: { invitationId: true },
      });
      await tx
        .update(emailVerificationTokens)
        .set({ consumedAt: sql`now()` })
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
        invitationId: invitation?.id ?? pending?.invitationId ?? null,
        ...emailAuthTokenTimes(),
      });
      return true;
    });
    if (!persisted) return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
  } catch (error) {
    logError("auth.resend_verification.persistence_failed", { error: error instanceof Error ? error.message : "unknown" });
    // Keep this endpoint enumeration-safe even when token persistence is
    // temporarily unavailable. No token is sent unless persistence succeeds.
    return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
  }

  // The replacement proof is committed before scheduling delivery. Provider
  // latency must not reveal which addresses have unverified accounts.
  // Next tracks this work for graceful shutdown; abrupt failure can still
  // require another rate-limited resend and never extends the token deadline.
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
      logError("auth.resend_verification.email_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  });

  return setRateLimitHeaders(NextResponse.json(GENERIC, { status: 202 }), rate);
}
