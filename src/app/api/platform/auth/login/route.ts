import { PlatformSessionExpiredError } from "../../../../../lib/platform-session-security";
import { clearLegacySessionCookies } from "../../../../../lib/session-config";
import { AuthenticationChangedError, sessionReplacementFromRequest } from "../../../../../lib/session-tokens";
import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { authenticatePlatformOwner, createPlatformSession, platformCookieHeader, platformRefreshCookieHeader } from "../../../../../lib/platform-auth";
import { clientIpFrom, reserveAuthAttempt, recordAuthSuccess, setRateLimitHeaders } from "../../../../../lib/auth-rate-limit";
import { logError, logWarn } from "../../../../../lib/log";
import { writeAuditEvent } from "../../../../../lib/audit";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || email.length > 320 || !password || password.length > 4096) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const clientIp = clientIpFrom(req);
  let decision: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    decision = await reserveAuthAttempt(clientIp, email);
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "platform_login", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 });
  }

  if (!decision.allowed) {
    logWarn("auth.platform_login.rate_limited", { ip: clientIp, retryAfterSec: decision.retryAfterSec });
    const res = NextResponse.json(
      { error: "Too many failed attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } }
    );
    return setRateLimitHeaders(res, decision);
  }

  let user: Awaited<ReturnType<typeof authenticatePlatformOwner>>;
  try {
    user = await authenticatePlatformOwner(email, password);
  } catch (error) {
    logError("auth.platform_login.user_lookup_failed", { error: error instanceof Error ? error.message : "unknown" });
    return setRateLimitHeaders(NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 }), decision);
  }
  if (!user) {
    logWarn("auth.platform_login.failed", { ip: clientIp });
    // v3: match customer/manager login — a failure that triggers the lock
    // returns 429 with Retry-After, not a misleading 401.
    const status = decision.retryAfterSec ? 429 : 401;
    const res = NextResponse.json(
      { error: "Invalid Platform Owner credentials or unverified account" },
      { status }
    );
    if (status === 429 && decision.retryAfterSec) res.headers.set("Retry-After", String(decision.retryAfterSec));
    return setRateLimitHeaders(res, decision);
  }

  // v3: clear the rate budget only after a session is actually issued (see
  // customer login); a session failure must not reset the budget.
  let session;
  try {
    session = await createPlatformSession(user.userId, user.email, {
      ipAddress: clientIp, userAgent: req.headers.get("user-agent"), replaceCurrent: sessionReplacementFromRequest(req, "platform"),
    }, user.credentialVersion);
  } catch (error) {
    if (error instanceof AuthenticationChangedError || error instanceof PlatformSessionExpiredError) return setRateLimitHeaders(NextResponse.json({ error: "Invalid Platform Owner credentials or unverified account" }, { status: 401 }), decision);
    logError("auth.platform_login.session_failed", { error: error instanceof Error ? error.message : "unknown" });
    return setRateLimitHeaders(NextResponse.json({ error: "Sign-in is temporarily unavailable. Try again in a moment." }, { status: 503 }), decision);
  }

  try {
    await recordAuthSuccess(clientIp, email);
  } catch (error) {
    logWarn("auth.platform_login.rate_limit_clear_failed", { error: error instanceof Error ? error.message : "unknown" });
  }

  // Settle the login audit before the response. A detached insert could race
  // with the next request's DB
  // snapshot, making a failed attempt appear to mutate established authority.
  await writeAuditEvent({
    tenantId: null,
    actorType: "platform",
    actorId: user.userId,
    action: "platform.login",
    resourceType: "platform_owner",
    resourceId: user.userId,
  }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));

  const response = NextResponse.json(
    { ok: true, expiresAt: session.exp.toISOString() },
    {
      status: 200,
      headers: {
        "Set-Cookie": platformCookieHeader(session.token, session.exp),
      },
    }
  );
  response.headers.append("Set-Cookie", platformRefreshCookieHeader(session.refreshToken, session.refreshExpiresAt));
  response.headers.set("Cache-Control", "no-store");
  clearLegacySessionCookies(response.headers, "platform");
  return setRateLimitHeaders(response, decision);
}
