import { NextResponse } from "next/server";
import { createManagerSession, managerCookieHeader, managerRefreshCookieHeader, verifyManagerPassword, getManagerUsername, resolveManagerTenantId, authenticateManagerUser } from "../../../../../lib/manager-auth";
import { isTrustedDesktopRequest } from "../../../../../lib/session-tokens";
import {
  clientIpFrom,
  reserveAuthAttempt,
  recordAuthSuccess,
  setRateLimitHeaders,
} from "../../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { logWarn, logInfo, logError, requestIdFrom } from "../../../../../lib/log";
import { writeAuditEvent } from "../../../../../lib/audit";

const INVALID = "Invalid credentials";

function tooMany(decision: Awaited<ReturnType<typeof reserveAuthAttempt>>) {
  const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  if (decision.retryAfterSec) res.headers.set("Retry-After", String(decision.retryAfterSec));
  return setRateLimitHeaders(res, decision);
}

export async function POST(req: Request) {
  const requestId = requestIdFrom(req);
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.slice(0, 128) : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password || password.length > 4096) {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }

  const expectedUser = getManagerUsername();
  const legacyTenantId = (process.env.MANAGER_TENANT_ID ?? "").trim();
  const desktopClient = isTrustedDesktopRequest(req);
  const ip = clientIpFrom(req);

  let pre: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    pre = await reserveAuthAttempt(ip, username);
    if (!pre.allowed) {
      logWarn("auth.login.rate_limited", { requestId, ip, retryAfterSec: pre.retryAfterSec });
      return tooMany(pre);
    }
  } catch (e) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "manager_login", requestId, error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 });
  }

  const tenantId = await resolveManagerTenantId(req);
  if (!tenantId) {
    return setRateLimitHeaders(NextResponse.json({ error: "Manager tenant is not configured for this hostname" }, { status: 503 }), pre);
  }

  let identity: { userId: string; role: import("../../../../../lib/manager-auth").ManagerRole } | null = null;
  if (!identity && username.includes("@")) {
    try {
      identity = await authenticateManagerUser(username, password, tenantId);
    } catch (e) {
      // A database/transport failure is operationally distinct from invalid
      // credentials. Never fall through to the 401 path when the identity
      // lookup itself could not be completed.
      logError("auth.login.user_lookup_failed", { requestId, error: e instanceof Error ? e.message : "unknown" });
      return setRateLimitHeaders(NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 }), pre);
    }
  }
  const legacyEnabled = process.env.NODE_ENV !== "production" && process.env.ALLOW_LEGACY_MANAGER_AUTH === "1";
  const legacyValid = legacyEnabled && expectedUser && legacyTenantId === tenantId
    ? await verifyManagerPassword(username, password)
    : false;
  if (!identity && !legacyValid) {
    logWarn("auth.login.failed", { requestId, ip });
    if (pre.retryAfterSec) return tooMany(pre);
    return setRateLimitHeaders(NextResponse.json({ error: INVALID }, { status: 401 }), pre);
  }

  try {
    await recordAuthSuccess(ip, username);
  } catch (e) {
    logWarn("auth.login.rate_limit_clear_failed", { requestId, error: e instanceof Error ? e.message : "unknown" });
  }

  let sess;
  try {
    sess = await createManagerSession(
      tenantId,
      identity ? { userId: identity.userId, role: identity.role } : { role: "owner" },
      {
        ipAddress: ip,
        userAgent: req.headers.get("user-agent"),
        email: username.includes("@") ? username : null,
      },
    );
  } catch (e) {
    logError("auth.login.session_failed", { requestId, error: e instanceof Error ? e.message : "unknown" });
    return setRateLimitHeaders(NextResponse.json({ error: "Sign-in is temporarily unavailable. Try again in a moment." }, { status: 500 }), pre);
  }

  logInfo("auth.login.success", { requestId, ip });
  await writeAuditEvent({ tenantId, actorType: identity ? "user" : "system", actorId: identity?.userId ?? "legacy-manager", action: "user.login.success", requestId, metadata: { desktopClient } }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  const bodyOut: { ok: true; expiresAt: string; accessToken?: string; refreshToken?: string } = {
    ok: true,
    expiresAt: sess.exp.toISOString(),
  };
  // The desktop shell cannot rely on cross-site HttpOnly cookies. Give only
  // the explicitly identified desktop client the short-lived bearer token;
  // browser login remains cookie-only and the cookie is still HttpOnly.
  if (desktopClient) {
    bodyOut.accessToken = sess.token;
    bodyOut.refreshToken = sess.refreshToken;
  }

  const res = NextResponse.json(bodyOut);
  if (!desktopClient) {
    res.headers.set("Set-Cookie", managerCookieHeader(sess.token, sess.exp));
    res.headers.append("Set-Cookie", managerRefreshCookieHeader(sess.refreshToken, sess.refreshExpiresAt));
  }
  res.headers.set("X-Request-Id", requestId);
  res.headers.set("Cache-Control", "no-store");
  return setRateLimitHeaders(res, pre);
}
