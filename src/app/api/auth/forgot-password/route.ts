import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { passwordResetTokens, users } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateOpaqueToken, hashToken, normalizeEmail } from "../../../../lib/password";
import { clientIpFrom, reserveAuthAttempt } from "../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { sendTransactionalEmail, appBaseUrl } from "../../../../lib/email";
import { nanoid } from "../../../../lib/nanoid";
export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const generic = { ok: true, message: "If the account exists, a password reset email will be sent." };
  let body: { email?: unknown }; try { body = await req.json(); } catch { return NextResponse.json(generic, { status: 202 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const ip = clientIpFrom(req);
  const rate = await reserveAuthAttempt(ip, email);
  if (!rate.allowed) { const res = NextResponse.json(generic, { status: 202 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return res; }
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id:true,email:true } });
  if (!user) return NextResponse.json(generic, { status: 202 });
  const raw=generateOpaqueToken(); const expiresAt=new Date(Date.now()+20*60_000);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`);
    await tx.update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt)));
    await tx.insert(passwordResetTokens).values({
      id: `prt_${nanoid(18)}`,
      userId: user.id,
      tokenHash: await hashToken(raw),
      expiresAt,
    });
  });
  try { const url=`${appBaseUrl(req)}/reset-password?token=${encodeURIComponent(raw)}`; await sendTransactionalEmail({to:user.email,subject:"Reset your Print Gateway password",html:`<p><a href="${url}">Reset password</a></p>`,text:`Reset your password: ${url}`}); } catch { /* Keep the response enumeration-safe. */ }
  // Do not clear the limiter here: a password-reset request is not a successful
  // authentication event. Clearing it would let an attacker repeatedly trigger
  // reset emails and bypass the abuse budget after every delivery.
  return NextResponse.json(generic, { status: 202 });
}
