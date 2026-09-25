import { logError, logWarn } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { authenticateForTenant, issueCustomerSession, customerSessionCookie, customerRefreshCookie } from "../../../../lib/customer-auth";
import { reserveAuthAttempt, clientIpFrom, recordAuthSuccess, setRateLimitHeaders } from "../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { writeAuditEvent } from "../../../../lib/audit";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { email?: unknown; password?: unknown; tenantId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const tenantId = typeof body.tenantId === "string" && body.tenantId.length <= 128 ? body.tenantId : undefined;
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
    const status = pre.allowed && pre.retryAfterSec ? 429 : 401;
    const res = NextResponse.json({ error: "Invalid email or password" }, { status });
    if (status === 429 && pre.retryAfterSec) res.headers.set("Retry-After", String(pre.retryAfterSec));
    return setRateLimitHeaders(res, pre);
  }
  await recordAuthSuccess(ip, email).catch((error) => logWarn("auth.login.rate_limit_clear_failed", { ip, error: error instanceof Error ? error.message : "unknown" }));
  if ("selectionToken" in identity && identity.multipleTenants) {
    return setRateLimitHeaders(NextResponse.json({
      error: "Choose a workspace",
      selectionToken: identity.selectionToken,
      workspaces: identity.memberships.map((m) => m.tenantId),
    }, { status: 409 }), pre);
  }
  if (!("tenantId" in identity) || !identity.tenantId || !identity.role) return setRateLimitHeaders(NextResponse.json({ error: "Workspace setup is incomplete" }, { status: 409 }), pre);
  const session = await issueCustomerSession(
    identity.userId,
    identity.tenantId,
    identity.role,
    {
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
    },
    email,
  );
  if (!session) {
    return setRateLimitHeaders(NextResponse.json({ error: "Workspace is unavailable" }, { status: 403 }), pre);
  }
  const res = NextResponse.json({ ok: true, expiresAt: session.accessExpiresAt.toISOString(), tenantId: identity.tenantId, role: identity.role });
  res.headers.set("Set-Cookie", customerSessionCookie(session));
  res.headers.append("Set-Cookie", customerRefreshCookie(session));
  await writeAuditEvent({ tenantId: identity.tenantId, actorType: "user", actorId: identity.userId, action: "user.login.success" }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  return setRateLimitHeaders(res, pre);
}
