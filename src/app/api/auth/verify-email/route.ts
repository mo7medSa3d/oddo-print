import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { db } from "../../../../db";
import { emailVerificationTokens, passwordResetTokens, tenantUsers, tenants, users } from "../../../../db/schema";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { generateOpaqueToken, hashPassword, hashToken } from "../../../../lib/password";
import { nanoid } from "../../../../lib/nanoid";
import { revokeLegacyManagerSessionsForUserInTransaction } from "../../../../lib/manager-auth";
import { revokeLegacyPlatformSessionsForUserInTransaction } from "../../../../lib/platform-auth";
import { revokeUserRefreshFamiliesInTransaction } from "../../../../lib/session-tokens";
import { clientIpFrom, recordAuthSuccess, reserveAuthAttempt, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { logError, logWarn } from "../../../../lib/log";
import { writeAuditEvent } from "../../../../lib/audit";
import type { ManagerRole } from "../../../../lib/manager-auth";
import { assertStagingWorkspaceSlot, StagingWorkspaceExistsError, STAGING_WORKSPACE_EXISTS_MESSAGE } from "../../../../lib/staging-single-workspace";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { token?: unknown }; try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length > 256) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  // Token-guessing throttle (mirrors login): no account identity is known
  // pre-token, so scope by endpoint + IP. Only a completed email proof
  // clears the budget; password setup is a separate authentication step.
  const ip = clientIpFrom(req);
  const tokenHash = await hashToken(token);
  // Known clients share an endpoint/source bucket; unattributed clients
  // share only the presented token's bucket, never a global lockout key.
  const rateIdentity = `verify-email-token:${ip === "unknown" ? tokenHash : ip}`;
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, rateIdentity);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "verify_email", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 });
  }
  if (!rate.allowed) {
    const limited = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    limited.headers.set("Retry-After", String(rate.retryAfterSec));
    return setRateLimitHeaders(limited, rate);
  }
  const row = await db.query.emailVerificationTokens.findFirst({
    where: and(
      eq(emailVerificationTokens.tokenHash, tokenHash),
      isNull(emailVerificationTokens.consumedAt),
      gt(emailVerificationTokens.expiresAt, sql`clock_timestamp()`),
    ),
  });
  if (!row) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId), columns: { id: true, emailVerifiedAt: true, email: true } });
  if (!user) return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
  const resetToken = generateOpaqueToken();
  // The submitted signup password may belong to an earlier unverified
  // registrant. Email proof must invalidate it before marking the email
  // usable for authentication; only the mailbox owner can choose the new one.
  let pendingPasswordHash: string;
  try {
    pendingPasswordHash = await hashPassword(generateOpaqueToken());
  } catch (error) {
    logError("auth.verify_email.password_setup_unavailable", { error: error instanceof Error ? error.message : "unknown" });
    return setRateLimitHeaders(NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 }), rate);
  }
  const auditMembership = await db.query.tenantUsers.findFirst({
    where: eq(tenantUsers.userId, user.id),
    columns: { tenantId: true },
  });
  let alreadyVerified = false;
  let tenantId: string;
  const isManagerRole = (value: string): value is ManagerRole =>
    value === "owner" ||
    value === "admin" ||
    value === "operator" ||
    value === "viewer" ||
    value === "integration_admin" ||
    value === "billing_admin";
  try {
    await db.transaction(async (tx) => {
      let auditTenantId: string | null = null;
      if (auditMembership?.tenantId) {
        const tenant = await tx.execute(sql`SELECT id FROM tenants WHERE id = ${auditMembership.tenantId} FOR SHARE`);
        if (tenant.rows[0]) auditTenantId = auditMembership.tenantId;
      }
      // Serialize all verification flows for this user before deciding whether
      // an initial workspace already exists.
      const lockedUser = await tx.execute(sql`
        SELECT id, email, email_verified_at AS "emailVerifiedAt"
        FROM users
        WHERE id = ${user.id}
        FOR UPDATE
      `);
      const currentUser = lockedUser.rows[0] as { id?: string; email?: string; emailVerifiedAt?: Date | string | null } | undefined;
      if (!currentUser?.id || !currentUser.email) throw new Error("USER_NOT_FOUND");

      const consumed = await tx.update(emailVerificationTokens)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(and(
          eq(emailVerificationTokens.id, row.id),
          isNull(emailVerificationTokens.consumedAt),
          gt(emailVerificationTokens.expiresAt, sql`clock_timestamp()`),
        ))
        .returning({ id: emailVerificationTokens.id });
      if (consumed.length !== 1) throw new Error("Verification token already consumed");
      if (currentUser.emailVerifiedAt) { alreadyVerified = true; return; }

      await tx.update(users)
        .set({ passwordHash: pendingPasswordHash, emailVerifiedAt: sql`COALESCE(email_verified_at, clock_timestamp())`, updatedAt: sql`now()` })
        .where(eq(users.id, currentUser.id));
      await revokeLegacyManagerSessionsForUserInTransaction(tx, currentUser.id);
      await revokeLegacyPlatformSessionsForUserInTransaction(tx, currentUser.id);
      await revokeUserRefreshFamiliesInTransaction(tx, currentUser.id, "email_verified_password_setup");
      await tx.update(passwordResetTokens)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(and(eq(passwordResetTokens.userId, currentUser.id), isNull(passwordResetTokens.consumedAt)));
      await tx.insert(passwordResetTokens).values({
        id: `prt_${nanoid(18)}`,
        userId: currentUser.id,
        tokenHash: await hashToken(resetToken),
        expiresAt: sql`clock_timestamp() + interval '20 minutes'`,
      });

      const existing = await tx.select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role })
        .from(tenantUsers)
        .where(eq(tenantUsers.userId, currentUser.id))
        .limit(1);
      if (existing[0]) {
        tenantId = existing[0].tenantId;
        if (!isManagerRole(existing[0].role)) throw new Error("INVALID_TENANT_ROLE");
      } else {
        // Serialize the first tenant allocation when HTTPS staging is locked
        // to one workspace. Production multi-tenant signup is unaffected.
        await assertStagingWorkspaceSlot(tx);
        tenantId = `ten_${nanoid(18)}`;
        await tx.insert(tenants).values({ id: tenantId, name: `${currentUser.email.split("@")[0]}'s Workspace` });
        await tx.insert(tenantUsers).values({ userId: currentUser.id, tenantId, role: "owner" });
        auditTenantId = tenantId;
      }

      await writeAuditEvent({
        // A membership created after the snapshot must not introduce an
        // inverted tenant FK lock while this transaction owns the user.
        tenantId: tenantId === auditTenantId ? auditTenantId : null,
        actorType: "user",
        actorId: currentUser.id,
        action: "user.email_verified",
      }, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Verification token already consumed") return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
    if (error instanceof Error && error.message === "USER_NOT_FOUND") return NextResponse.json({ error: "Invalid or expired verification link" }, { status: 400 });
    if (error instanceof Error && error.message === "INVALID_TENANT_ROLE") return NextResponse.json({ error: "Workspace is unavailable" }, { status: 403 });
    if (error instanceof StagingWorkspaceExistsError) {
      return setRateLimitHeaders(NextResponse.json({
        error: STAGING_WORKSPACE_EXISTS_MESSAGE,
        code: "STAGING_WORKSPACE_EXISTS",
      }, { status: 409 }), rate);
    }
    throw error;
  }
  const response = NextResponse.json({
    ok: true,
    next: alreadyVerified ? "/login" : `/reset-password?token=${encodeURIComponent(resetToken)}&setup=1`,
    requiresPasswordSetup: !alreadyVerified,
  });
  response.headers.set("Cache-Control", "no-store");
  await recordAuthSuccess(ip, rateIdentity).catch((error) => logWarn("auth.verify_email.rate_limit_clear_failed", { ip, error: error instanceof Error ? error.message : "unknown" }));
  return setRateLimitHeaders(response, rate);
}
