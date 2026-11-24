import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { emailVerificationTokens, tenantInvitations, tenants, users } from "../../../../../db/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { generateOpaqueToken, hashPassword, hashToken, normalizeEmail } from "../../../../../lib/password";
import { nanoid } from "../../../../../lib/nanoid";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { clientIpFrom, reserveAuthAttempt, setRateLimitHeaders } from "../../../../../lib/auth-rate-limit";
import { logError } from "../../../../../lib/log";
import { appBaseUrl, sendTransactionalEmail } from "../../../../../lib/email";
import { getServerLocale, makeT } from "../../../../../i18n/server";
import { findActiveInvitation, joinWorkspaceByInvitation } from "../../../../../lib/invitation-join";
import { customerSessionCookie, customerRefreshCookie } from "../../../../../lib/customer-auth";
import { validateWorkspaceManager, type ManagerRole } from "../../../../../lib/manager-auth";
import { issueSessionPairInTransaction, revokeSessionFamilyInTransaction, AuthenticationChangedError, type SessionPair } from "../../../../../lib/session-tokens";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../../lib/manager-mutation-authorization";
import { WorkspaceSessionExpiredError, workspacePolicyResponse } from "../../../../../lib/workspace-session-security";
import { clearLegacySessionCookies } from "../../../../../lib/session-config";
import { emailAuthTokenTimes } from "../../../../../lib/email-auth-token-policy";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/** An invitation never provisions a second tenant. New employees receive a
 * mailbox-proof link and choose their password only after email verification.
 * Existing employees must authenticate as the invited mailbox. */
export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024))
    return NextResponse.json({ error: "Request body too large" }, { status: 413, headers });

  let payload: { token?: unknown; email?: unknown };
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Expected object");
    payload = body as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }
  const token = typeof payload.token === "string" ? payload.token : "";
  if (!token || token.length > 256)
    return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400, headers });

  const tokenHash = await hashToken(token);
  const ip = clientIpFrom(req);
  const rateIdentity = `invitation-token:${ip === "unknown" ? tokenHash : ip}`;
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, rateIdentity, "invitation-accept");
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "invitation_accept", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503, headers });
  }
  const respond = (body: Record<string, unknown>, status: number) =>
    setRateLimitHeaders(NextResponse.json(body, { status, headers }), rate);
  if (!rate.allowed) {
    const res = respond({ error: "Too many attempts. Try again later." }, 429);
    res.headers.set("Retry-After", String(rate.retryAfterSec));
    return res;
  }

  const invitation = await findActiveInvitation(token);
  if (!invitation || (typeof payload.email === "string" && normalizeEmail(payload.email) !== invitation.email))
    return respond({ error: "Invitation is invalid or expired" }, 400);

  // Check before onboarding/sign-in branches, and again *under the tenant row
  // lock* at the write. Suspended/deleted workspaces cannot enroll members.
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, invitation.tenantId),
    columns: { id: true, lifecycle: true },
  });
  if (!tenant || tenant.lifecycle !== "active")
    return respond({ error: "Workspace suspended or unavailable", code: "WORKSPACE_UNAVAILABLE" }, 409);

  const account = await db.query.users.findFirst({
    where: eq(users.email, invitation.email),
    columns: { id: true, email: true, emailVerifiedAt: true },
  });
  if (!account) {
    // No password is collected or chosen by the inviter. The random verifier
    // cannot authenticate. The mailbox owner will set a password after proving
    // email ownership, without being sent to public signup/onboarding.
    const userId = `usr_${nanoid(18)}`;
    const rawVerification = generateOpaqueToken();
    let passwordHash: string;
    try { passwordHash = await hashPassword(generateOpaqueToken()); }
    catch { return respond({ error: "Invitation onboarding temporarily unavailable" }, 503); }
    try {
      const created = await db.transaction(async tx => {
        const lockedTenant = await tx.execute(sql`SELECT id, lifecycle FROM tenants WHERE id = ${invitation.tenantId} FOR UPDATE`);
        if (!lockedTenant.rows[0]?.id || lockedTenant.rows[0]?.lifecycle !== "active")
          throw new Error("INVITATION_WORKSPACE_UNAVAILABLE");
        const live = await tx.query.tenantInvitations.findFirst({
          where: and(eq(tenantInvitations.id, invitation.id),
            eq(tenantInvitations.tokenHash, invitation.tokenHash),
            isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt),
            gt(tenantInvitations.expiresAt, sql`clock_timestamp()`)),
        });
        if (!live) throw new Error("INVITATION_INVALID");
        const added = await tx.insert(users).values({
          id: userId, email: invitation.email, passwordHash,
        }).onConflictDoNothing().returning({ id: users.id });
        if (added.length === 0) return false; // concurrent signup: recover via resend
        await tx.insert(emailVerificationTokens).values({
          id: `evt_${nanoid(18)}`, userId,
          tokenHash: await hashToken(rawVerification),
          invitationId: invitation.id,
          ...emailAuthTokenTimes(),
        });
        return true;
      });
      if (!created) return respond({ code: "VERIFY_EMAIL_REQUIRED" }, 409);
    } catch (error) {
      if (error instanceof Error && (error.message === "INVITATION_WORKSPACE_UNAVAILABLE" || error.message === "INVITATION_INVALID"))
        return respond({ error: "Invitation is no longer available", code: error.message }, 409);
      logError("team.invitation_onboarding_failed", { error: error instanceof Error ? error.message : "unknown" });
      return respond({ error: "Invitation onboarding temporarily unavailable" }, 503);
    }
    try {
      const t = makeT(await getServerLocale());
      const url = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(rawVerification)}&invite=${encodeURIComponent(token)}`;
      await sendTransactionalEmail({
        to: invitation.email,
        subject: t("mail.verify.subject"),
        html: `<p>${t("mail.verify.body")}</p><p><a href="${url}">${t("mail.verify.cta")}</a></p><p>${t("mail.verify.expires")}</p>`,
        text: t("mail.verify.text", { url }),
      });
    } catch (error) {
      logError("team.invitation_verification_email_failed", { error: error instanceof Error ? error.message : "unknown" });
      // The durable pending identity remains and can request a new link.
      return respond({ error: "Check your mailbox or request a new verification email", code: "VERIFY_EMAIL_REQUIRED" }, 503);
    }
    return respond({ ok: true, code: "VERIFICATION_SENT" }, 202);
  }

  if (!account.emailVerifiedAt) {
    // Never grant a membership to an unverified account. The browser can ask
    // the existing, rate-limited resend-verification endpoint for fresh proof.
    return respond({ code: "VERIFY_EMAIL_REQUIRED" }, 409);
  }

  // An invited, verified user may already have an authenticated customer OR
  // manager workspace session. A customer-only check spuriously demanded a
  // second password even though the matching manager session had live proof.
  // Legacy sessions without an independently revocable v2 family cannot
  // switch workspaces through a bearer invitation.
  const principal = await validateWorkspaceManager(req);
  if (!principal?.userId || principal.userId !== account.id || principal.ver !== 2 || !principal.familyId)
    return respond({ code: "SIGN_IN_REQUIRED" }, 401);

  let result: { membership: { tenantId: string; role: string }; session: SessionPair };
  try {
    result = await db.transaction(async tx => {
      // Invitation acceptance continues an existing login; possession of an
      // invitation and a stored password hash is not a new password check.
      // Lock both tenant fences before user/family state. The invited tenant
      // is locked FOR UPDATE here because membership admission needs that
      // lock later, and upgrading after user locks could invert writer order.
      const tenantIds = [...new Set([principal.tenantId, invitation.tenantId])].sort();
      const locked = await tx.execute(sql`SELECT id,lifecycle FROM tenants
        WHERE id IN (${sql.join(tenantIds.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
      if (!locked.rows.some(row => row.id === principal.tenantId && row.lifecycle === "active")) throw new WorkspaceSessionExpiredError();
      if (!locked.rows.some(row => row.id === invitation.tenantId && row.lifecycle === "active")) throw new Error("INVITATION_WORKSPACE_UNAVAILABLE");
      await requireManagerActorInTransaction(tx, principal, "tenant.read");
      const membership = await joinWorkspaceByInvitation(tx, invitation, account.id, account.email);
      const session = await issueSessionPairInTransaction(tx, {
        kind: "customer", userId: account.id, tenantId: membership.tenantId,
        role: membership.role as ManagerRole, email: account.email,
      }, { ipAddress: ip, userAgent: req.headers.get("user-agent"), continueWorkspace: principal });
      await revokeSessionFamilyInTransaction(tx, principal.familyId!, "invitation_acceptance");
      return { membership, session };
    });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return error.response();
    if (error instanceof WorkspaceSessionExpiredError) return workspacePolicyResponse(error);
    if (error instanceof AuthenticationChangedError) return respond({ code: "SIGN_IN_REQUIRED" }, 401);
    const code = error instanceof Error ? error.message : "INVITATION_FAILED";
    if (code === "INVITATION_ALREADY_MEMBER") return respond({ code: "ALREADY_MEMBER" }, 409);
    if (code === "INVITATION_WORKSPACE_UNAVAILABLE" || code === "INVITATION_INVALID" || code === "INVITATION_IDENTITY_MISMATCH")
      return respond({ error: "Invitation is invalid or expired", code }, 409);
    logError("team.invitation_accept_failed", { error: code });
    return respond({ error: "Invitation temporarily unavailable" }, 503);
  }
  const res = respond({ ok: true, code: "INVITATION_ACCEPTED",
    tenantId: result.membership.tenantId, sessionEstablished: true }, 200);
  res.headers.set("Set-Cookie", customerSessionCookie(result.session));
  res.headers.append("Set-Cookie", customerRefreshCookie(result.session));
  clearLegacySessionCookies(res.headers, "customer");
  return res;
}
