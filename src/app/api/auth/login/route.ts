import { logError, logWarn } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { authenticateForTenant, issueCustomerSession, customerSessionCookie, customerRefreshCookie } from "../../../../lib/customer-auth";
import { reserveAuthAttempt, clientIpFrom, recordAuthSuccess, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { sessionReplacementFromRequest, type SessionPair } from "../../../../lib/session-tokens";
import { clearLegacySessionCookies } from "../../../../lib/session-config";
import { writeAuditEvent } from "../../../../lib/audit";
import { workspaceSecurityErrorResponse } from "../../../../lib/workspace-session-http";
import { joinInvitationWithPassword } from "../../../../lib/invitation-join";
import type { ManagerRole } from "../../../../lib/manager-auth";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { email?: unknown; password?: unknown; tenantId?: unknown; inviteToken?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (body.tenantId !== undefined && (typeof body.tenantId !== "string" || !body.tenantId || body.tenantId.length > 128))
    return NextResponse.json({ error: "Invalid workspace selection", code: "INVALID_REQUEST" }, { status: 400 });
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : undefined;
  if (body.inviteToken !== undefined && (typeof body.inviteToken !== "string" || !body.inviteToken || body.inviteToken.length > 256))
    return NextResponse.json({ error: "Invitation is invalid or expired", code: "INVITATION_INVALID" }, { status: 400 });
  const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken : "";
  // Two different workspace authorities must never silently override one another.
  if (tenantId && inviteToken)
    return NextResponse.json({ error: "Select either a workspace or an invitation", code: "INVALID_REQUEST" }, { status: 400 });
  if (!email || !password || password.length > 4096) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  const ip = clientIpFrom(req);
  let pre: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    pre = await reserveAuthAttempt(ip, email);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "customer_login", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 });
  }
  if (!pre.allowed) {
    const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    res.headers.set("Retry-After", String(pre.retryAfterSec));
    return setRateLimitHeaders(res, pre);
  }
  let identity: Awaited<ReturnType<typeof authenticateForTenant>>;
  try {
    identity = await authenticateForTenant(email, password, tenantId);
  } catch (error) {
    logError("auth.login.authentication_failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return setRateLimitHeaders(NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 }), pre);
  }
  if (!identity) {
    logWarn("auth.login.failed", { ip });
    const status = pre.allowed && pre.retryAfterSec ? 429 : 401;
    const res = NextResponse.json({ error: "Invalid email or password" }, { status });
    if (status === 429 && pre.retryAfterSec) res.headers.set("Retry-After", String(pre.retryAfterSec));
    return setRateLimitHeaders(res, pre);
  }
  // v3: the rate budget is cleared only once authentication has actually
  // produced a session (or a selection token for a multi-workspace user).
  // Clearing before issuance let a suspended-tenant login both fail and
  // reset the account's failure budget.
  if (!inviteToken && "selectionToken" in identity && identity.multipleTenants) {
    await recordAuthSuccess(ip, email).catch((error) => logWarn("auth.login.rate_limit_clear_failed", { ip, error: error instanceof Error ? error.message : "unknown" }));
    return setRateLimitHeaders(NextResponse.json({
      error: "Choose a workspace",
      selectionToken: identity.selectionToken,
      workspaces: identity.memberships.map((m) => m.tenantId),
      workspaceOptions: identity.memberships.map((m) => ({ id: m.tenantId, name: m.name })),
    }, { status: 409, headers: { "Cache-Control": "no-store" } }), pre);
  }
  try {
    let resolvedTenantId = "tenantId" in identity ? identity.tenantId : undefined;
    let resolvedRole: ManagerRole | undefined = "role" in identity ? identity.role : undefined;
    let invitationSession: SessionPair | undefined;
    // A verified offer always targets the invited workspace, regardless of
    // whether the user belongs to one or multiple other workspaces.
    if (inviteToken) {
      const joined = await joinInvitationWithPassword(inviteToken, identity, {
        ipAddress: ip, userAgent: req.headers.get("user-agent"), replaceCurrent: sessionReplacementFromRequest(req, "customer"),
      });
      resolvedTenantId = joined.membership.tenantId;
      resolvedRole = joined.membership.role as ManagerRole;
      invitationSession = joined.session;
    }
    if (!resolvedTenantId || !resolvedRole) return setRateLimitHeaders(NextResponse.json({ error: "Workspace setup is incomplete" }, { status: 409 }), pre);
    const session = invitationSession ?? await issueCustomerSession(identity.userId, resolvedTenantId, resolvedRole, {
      ipAddress: ip, userAgent: req.headers.get("user-agent"), replaceCurrent: sessionReplacementFromRequest(req, "customer"),
    }, identity.email, identity.credentialVersion);
    if (!session) return setRateLimitHeaders(NextResponse.json({ error: "Invalid email or password" }, { status: 401 }), pre);
    await recordAuthSuccess(ip, email).catch((error) => logWarn("auth.login.rate_limit_clear_failed", { ip, error: error instanceof Error ? error.message : "unknown" }));
    await writeAuditEvent({ tenantId: resolvedTenantId, actorType: "user", actorId: identity.userId,
      action: "user.login.success", resourceType: "session", resourceId: session.familyId }).catch(error =>
      logError("audit_write_failed", { error: error instanceof Error ? error.message : "unknown" }));
    const response = NextResponse.json({ ok: true, tenantId: resolvedTenantId, role: resolvedRole, expiresAt: session.accessExpiresAt.toISOString(),
      ...(invitationSession ? { invitationAccepted: true } : {}),
    }, {
      headers: { "Cache-Control": "private, no-store", "Set-Cookie": customerSessionCookie(session) },
    });
    response.headers.append("Set-Cookie", customerRefreshCookie(session));
    clearLegacySessionCookies(response.headers, "customer");
    return setRateLimitHeaders(response, pre);
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_ALREADY_MEMBER")
      return setRateLimitHeaders(NextResponse.json({ code: "INVITATION_ALREADY_MEMBER" }, { status: 409 }), pre);
    if (error instanceof Error && error.message === "INVITATION_WORKSPACE_UNAVAILABLE")
      return setRateLimitHeaders(NextResponse.json({ code: "INVITATION_WORKSPACE_UNAVAILABLE" }, { status: 409 }), pre);
    if (error instanceof Error && error.message.startsWith("INVITATION_"))
      return setRateLimitHeaders(NextResponse.json({ error: "Invitation is invalid or expired", code: "INVITATION_INVALID" }, { status: 409 }), pre);
    return workspaceSecurityErrorResponse(error);
  }
}
