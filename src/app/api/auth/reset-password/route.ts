import { logError, logWarn } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { db } from "../../../../db";
import { passwordResetTokens, tenantUsers, users } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { hashPassword, hashToken } from "../../../../lib/password";
import { clientIpFrom, refundAuthReservation, reserveAuthAttempt, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { writeAuditEvent } from "../../../../lib/audit";
import { revokeLegacyManagerSessionsForUserInTransaction } from "../../../../lib/manager-auth";
import { revokeLegacyPlatformSessionsForUserInTransaction } from "../../../../lib/platform-auth";
import { revokeUserRefreshFamiliesInTransaction } from "../../../../lib/session-tokens";
import { passwordScreeningFailure, screenNewPassword } from "../../../../lib/password-screening";
import { emailAuthTokenIsLive } from "../../../../lib/email-auth-token-policy";
import { isValidNewPasswordLength } from "../../../../lib/new-password-policy";
import { issueCustomerSession, customerSessionCookie, customerRefreshCookie } from "../../../../lib/customer-auth";
import { credentialVersionFor } from "../../../../lib/session-credentials";
import type { ManagerRole } from "../../../../lib/manager-auth";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { token?: unknown; password?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token || !isValidNewPasswordLength(password)) {
    return NextResponse.json({ error: "Invalid or incomplete reset request" }, { status: 400 });
  }

  // Token-guessing throttle (mirrors forgot-password/login): the limiter key
  // has no account identity pre-token, so scope by endpoint + IP. Every
  // guess consumes budget; only a completed reset clears it.
  const ip = clientIpFrom(req);
  const tokenHash = await hashToken(token);
  // Known clients share an endpoint/source bucket; unattributed clients
  // share only the presented token's bucket, never a global lockout key.
  const rateIdentity = `reset-password-token:${ip === "unknown" ? tokenHash : ip}`;
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, rateIdentity, "reset-password");
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "reset_password", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 });
  }
  if (!rate.allowed) {
    const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfterSec));
    return setRateLimitHeaders(res, rate);
  }

  const row = await db.query.passwordResetTokens.findFirst({
    where: and(
      eq(passwordResetTokens.tokenHash, tokenHash),
      isNull(passwordResetTokens.consumedAt),
      emailAuthTokenIsLive(passwordResetTokens),
    ),
  });
  if (!row) return NextResponse.json({ error: "Reset link expired or invalid" }, { status: 400 });
  // Only mailbox-proof setup tokens may create a first authenticated session.
  // The untrusted URL query (?setup=1) cannot grant this capability.
  const initialSetup = row.id.startsWith("psu_");

  // A provider outage or breached candidate must not consume the reset proof.
  const passwordFailure = passwordScreeningFailure(await screenNewPassword(password));
  if (passwordFailure) return setRateLimitHeaders(NextResponse.json(passwordFailure.body, { status: passwordFailure.status }), rate);
  const nextHash = await hashPassword(password);
  const auditMembership = await db.query.tenantUsers.findFirst({
    where: eq(tenantUsers.userId, row.userId),
    columns: { tenantId: true },
  });

  try {
    await db.transaction(async (tx) => {
      // Recovery works for suspended workspaces too. Lock only the audit
      // association before the user, in the same order as tenant lifecycle
      // writers; never acquire a new tenant FK lock after the user lock.
      let auditTenantId: string | null = null;
      if (auditMembership?.tenantId) {
        const tenant = await tx.execute(sql`SELECT id FROM tenants WHERE id = ${auditMembership.tenantId} FOR SHARE`);
        if (tenant.rows[0]) auditTenantId = auditMembership.tenantId;
      }
      // Same user -> token lock order as forgot-password issuance.
      await tx.execute(sql`SELECT id FROM users WHERE id = ${row.userId} FOR UPDATE`);
      const consumed = await tx
        .update(passwordResetTokens)
        .set({ consumedAt: sql`now()` })
        .where(and(
          eq(passwordResetTokens.id, row.id),
          isNull(passwordResetTokens.consumedAt),
          emailAuthTokenIsLive(passwordResetTokens),
        ))
        .returning({ id: passwordResetTokens.id });

      if (consumed.length !== 1) throw new Error("Reset token already consumed");

      const updatedUser = await tx.update(users)
        .set({ passwordHash: nextHash, updatedAt: sql`now()` })
        .where(eq(users.id, row.userId))
        .returning({ id: users.id });
      if (updatedUser.length !== 1) throw new Error("Reset user missing");

      // Revoke pre-cutover legacy sessions as part of the bounded compatibility window.
      await revokeLegacyManagerSessionsForUserInTransaction(tx, row.userId);
      await revokeLegacyPlatformSessionsForUserInTransaction(tx, row.userId);

      // Password reset is a session-boundary event: every v2 refresh family for
      // the account must be revoked so an attacker holding an old refresh token
      // cannot mint a new access token after the password changes.
      await revokeUserRefreshFamiliesInTransaction(tx, row.userId, "password_reset");

      await writeAuditEvent(
        {
          tenantId: auditTenantId,
          actorType: "user",
          actorId: row.userId,
          action: "user.password_reset_completed",
        },
        tx
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Reset token already consumed") {
      return NextResponse.json({ error: "Reset link expired or invalid" }, { status: 400 });
    }
    logError("password_reset_transaction_failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Password reset failed" }, { status: 500 });
  }

  await refundAuthReservation(ip, rateIdentity, "reset-password").catch((error) => logWarn("auth.reset_password.rate_limit_clear_failed", { ip, error: error instanceof Error ? error.message : "unknown" }));
  if (initialSetup) {
    // The setup password is the user's first credential, not a recovery event.
    // Mint a fresh, server-validated customer session after the transaction
    // revokes any previous session families. Ordinary reset proofs never do so.
    try {
      // WP3 (STATIC REVIEW ONLY, B2-03): the previous findFirst with no
      // orderBy picked an arbitrary membership when a second one appeared
      // between email verification and password setup (e.g. a
      // platform-owner direct add), landing the user in the wrong
      // workspace. No privilege gain either way (both memberships are
      // theirs) and no cross-tenant leak, but the workspace must not be
      // a coin flip. Only auto-issue the setup session when exactly one
      // membership exists (the normal setup case, behaviour unchanged);
      // with zero or several, fall through to authenticated:false and
      // let the user sign in / choose a workspace through the normal flow.
      // The setup token carries no tenant link, so "the membership the
      // verification transaction created" cannot be identified from this
      // route without a schema change; preferring createdAt order would
      // still be a silent pick, not a decision.
      const members = await db.query.tenantUsers.findMany({
        where: eq(tenantUsers.userId, row.userId),
        columns: { tenantId: true, role: true },
      });
      const member = members.length === 1 ? members[0] : undefined;
      const account = await db.query.users.findFirst({
        where: eq(users.id, row.userId),
        columns: { email: true },
      });
      const isManagerRole = (value: string): value is ManagerRole =>
        ["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"].includes(value);
      if (member && account?.email && isManagerRole(member.role)) {
        const session = await issueCustomerSession(row.userId, member.tenantId, member.role, {
          ipAddress: ip,
          userAgent: req.headers.get("user-agent"),
        }, account.email, credentialVersionFor(row.userId, nextHash));
        if (session) {
          const response = NextResponse.json({ ok: true, authenticated: true }, {
            headers: {
              "Cache-Control": "private, no-store",
              "Set-Cookie": customerSessionCookie(session),
            },
          });
          response.headers.append("Set-Cookie", customerRefreshCookie(session));
          return setRateLimitHeaders(response, rate);
        }
      }
    } catch (error) {
      // The new password has already committed. Never claim it failed or
      // mint a weaker session: the user can sign in normally if this fails.
      logError("auth.password_setup.session_unavailable", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return setRateLimitHeaders(NextResponse.json({ ok: true, authenticated: false }, {
    headers: { "Cache-Control": "private, no-store" },
  }), rate);
}
