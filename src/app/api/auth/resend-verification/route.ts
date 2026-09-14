import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { emailVerificationTokens, users } from "../../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { generateOpaqueToken, hashToken, normalizeEmail } from "../../../../../lib/password";
import { sendTransactionalEmail, appBaseUrl } from "../../../../../lib/email";
import { nanoid } from "nanoid";
import { clientIpFrom, inspectAuthRateLimit } from "../../../../../lib/auth-rate-limit";
export async function POST(req: Request) {
  let body: { email?: unknown }; try { body = await req.json(); } catch { return NextResponse.json({ ok: true }); }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const ip = clientIpFrom(req);
  const rate = await inspectAuthRateLimit(ip, email);
  const generic = { ok: true, message: "If the account exists and still needs verification, a new email will be sent." };
  if (!rate.allowed) { const res = NextResponse.json(generic, { status: 202 }); res.headers.set("Retry-After", String(rate.retryAfterSec)); return res; }
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true, email: true, emailVerifiedAt: true } });
  if (!user || user.emailVerifiedAt) { if (!user) await import("../../../../../lib/auth-rate-limit").then(({ recordAuthFailure }) => recordAuthFailure(ip, email)).catch(() => undefined); return NextResponse.json(generic, { status: 202 }); }
  const raw = generateOpaqueToken(); const expiresAt = new Date(Date.now()+30*60_000);
  await db.update(emailVerificationTokens).set({ consumedAt: new Date() }).where(and(eq(emailVerificationTokens.userId, user.id), isNull(emailVerificationTokens.consumedAt)));
  await db.insert(emailVerificationTokens).values({ id:`evt_${nanoid(18)}`, userId:user.id, tokenHash:await hashToken(raw), expiresAt });
  try { const url=`${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(raw)}`; await sendTransactionalEmail({to:user.email,subject:"Verify your Print Gateway account",html:`<p><a href="${url}">Verify email</a></p>`,text:`Verify email: ${url}`}); } catch { /* Keep the response enumeration-safe. */ }
  await import("../../../../../lib/auth-rate-limit").then(({ recordAuthSuccess }) => recordAuthSuccess(email)).catch(() => undefined);
  return NextResponse.json(generic, { status: 202 });
}
