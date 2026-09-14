import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { passwordResetTokens, users } from "../../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { generateOpaqueToken, hashToken, normalizeEmail } from "../../../../../lib/password";
import { clientIpFrom, inspectAuthRateLimit } from "../../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { sendTransactionalEmail, appBaseUrl } from "../../../../../lib/email";
import { nanoid } from "nanoid";
export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const generic = { ok: true, message: "If the account exists, a password reset email will be sent." };
  let body: { email?: unknown }; try { body = await req.json(); } catch { return NextResponse.json(generic, { status: 202 }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const ip = clientIpFrom(req);
  const rate = await inspectAuthRateLimit(ip, email);
  if (!rate.allowed) { const res = NextResponse.json(generic, { status: 202 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return res; }
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id:true,email:true } });
  if (!user) { await import("../../../../../lib/auth-rate-limit").then(({ recordAuthFailure }) => recordAuthFailure(ip, email)).catch(() => undefined); return NextResponse.json(generic, { status: 202 }); }
  const raw=generateOpaqueToken(); const expiresAt=new Date(Date.now()+20*60_000);
  await db.update(passwordResetTokens).set({ consumedAt:new Date() }).where(and(eq(passwordResetTokens.userId,user.id),isNull(passwordResetTokens.consumedAt)));
  await db.insert(passwordResetTokens).values({id:`prt_${nanoid(18)}`,userId:user.id,tokenHash:await hashToken(raw),expiresAt});
  try { const url=`${appBaseUrl(req)}/reset-password?token=${encodeURIComponent(raw)}`; await sendTransactionalEmail({to:user.email,subject:"Reset your Print Gateway password",html:`<p><a href="${url}">Reset password</a></p>`,text:`Reset your password: ${url}`}); } catch { /* Keep the response enumeration-safe. */ }
  await import("../../../../../lib/auth-rate-limit").then(({ recordAuthSuccess }) => recordAuthSuccess(email)).catch(() => undefined);
  return NextResponse.json(generic, { status: 202 });
}
