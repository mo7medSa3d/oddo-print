import { NextResponse } from "next/server";
import {
  clearCustomerRefreshCookie,
  clearCustomerSessionCookie,
  customerRefreshCookie,
  customerSessionCookie,
} from "../../../../lib/customer-auth";
import { clientIpFrom } from "../../../../lib/auth-rate-limit";
import {
  getRefreshTokenFromRequest,
  rotateRefreshToken,
} from "../../../../lib/session-tokens";
import { logError } from "../../../../lib/log";

export async function POST(req: Request) {
  const token = getRefreshTokenFromRequest(req, "customer");
  if (!token) {
    const response = NextResponse.json({ error: "Refresh authentication required" }, { status: 401 });
    response.headers.set("Set-Cookie", clearCustomerSessionCookie());
    response.headers.append("Set-Cookie", clearCustomerRefreshCookie());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  let outcome: Awaited<ReturnType<typeof rotateRefreshToken>>;
  try {
    outcome = await rotateRefreshToken("customer", token, {
      ipAddress: clientIpFrom(req),
      userAgent: req.headers.get("user-agent"),
    });
  } catch (error) {
    logError("auth.customer_refresh.failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Session refresh temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (outcome.status !== "rotated") {
    const response = NextResponse.json({ error: "Refresh token is invalid or expired" }, { status: 401 });
    response.headers.set("Set-Cookie", clearCustomerSessionCookie());
    response.headers.append("Set-Cookie", clearCustomerRefreshCookie());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const response = NextResponse.json({
    ok: true,
    expiresAt: outcome.pair.accessExpiresAt.toISOString(),
  });
  response.headers.set("Set-Cookie", customerSessionCookie(outcome.pair));
  response.headers.append("Set-Cookie", customerRefreshCookie(outcome.pair));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
