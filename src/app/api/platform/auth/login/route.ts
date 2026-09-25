import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { authenticatePlatformOwner, createPlatformSession, platformCookieHeader } from "../../../../../lib/platform-auth";
import { clientIpFrom, reserveAuthAttempt, recordAuthSuccess, setRateLimitHeaders } from "../../../../../lib/auth-rate-limit";
import { logError } from "../../../../../lib/log";
import { writeAuditEvent } from "../../../../../lib/audit";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
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
    const res = NextResponse.json(
      { error: "Too many failed attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } }
    );
    return setRateLimitHeaders(res, decision);
  }

  const user = await authenticatePlatformOwner(email, password);
  if (!user) {
    return setRateLimitHeaders(
      NextResponse.json({ error: "Invalid Platform Owner credentials or unverified account" }, { status: 401 }),
      decision
    );
  }

  await recordAuthSuccess(clientIp, email);

  const session = await createPlatformSession(user.userId, user.email);

  void writeAuditEvent({
    tenantId: null,
    actorType: "platform",
    actorId: user.userId,
    action: "platform.login",
    resourceType: "platform_owner",
    resourceId: user.userId,
  }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));

  return setRateLimitHeaders(NextResponse.json(
    { ok: true, user: { id: user.userId, email: user.email } },
    {
      headers: {
        "Set-Cookie": platformCookieHeader(session.token, session.exp),
      },
    }
  ), decision);
}
