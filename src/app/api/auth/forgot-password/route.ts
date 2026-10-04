import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { passwordResetTokens, users } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateOpaqueToken, hashToken, normalizeEmail } from "../../../../lib/password";
import { clientIpFrom, reserveAuthAttempt, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { logError } from "../../../../lib/log";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { getServerLocale, makeT } from "../../../../i18n/server";
import { nanoid } from "../../../../lib/nanoid";
export async function POST(req: Request) {
  const t = makeT(await getServerLocale());
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const generic = { ok: true, message: "If the account exists, a password reset email will be sent." };
  let body: { email?: unknown }; try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json(generic, { status: 202 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const ip = clientIpFrom(req);
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, email);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "forgot_password", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(generic, { status: 503 });
  }
  if (!rate.allowed) { const res = NextResponse.json(generic, { status: 202 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return setRateLimitHeaders(res, rate); }
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id:true,email:true } });
  if (!user) return setRateLimitHeaders(NextResponse.json(generic, { status: 202 }), rate);
  const raw=generateOpaqueToken();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`);
    await tx.update(passwordResetTokens)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt)));
    await tx.insert(passwordResetTokens).values({
      id: `prt_${nanoid(18)}`,
      userId: user.id,
      tokenHash: await hashToken(raw),
      expiresAt: sql`clock_timestamp() + interval '20 minutes'`,
    });
  });
  try {
    const url = `${appBaseUrl(req)}/reset-password?token=${encodeURIComponent(raw)}`;
    await sendTransactionalEmail({
      to: user.email,
      subject: t("mail.reset.subject"),
      html: `<p><a href="${url}">${t("mail.reset.cta")}</a></p>`,
      text: t("mail.reset.text", { url }),
    });
  } catch (error) {
    // Keep the response enumeration-safe, but retain an operational signal so
    // failed email delivery is diagnosable without exposing the recipient.
    logError("auth.forgot_password.reset_email_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Do not clear the limiter here: a password-reset request is not a successful
  // authentication event. Clearing it would let an attacker repeatedly trigger
  // reset emails and bypass the abuse budget after every delivery.
  return setRateLimitHeaders(NextResponse.json(generic, { status: 202 }), rate);
}
