import { NextResponse } from "next/server";
import {
  clearPlatformCookieHeader,
  clearPlatformRefreshCookieHeader,
  platformCookieHeader,
  platformRefreshCookieHeader,
} from "../../../../../lib/platform-auth";
import { clientIpFrom } from "../../../../../lib/auth-rate-limit";
import {
  getRefreshTokenFromRequest,
  rotateRefreshToken,
} from "../../../../../lib/session-tokens";
import { logError } from "../../../../../lib/log";

export async function POST(req: Request) {
  const token = getRefreshTokenFromRequest(req, "platform");
  if (!token) {
    const response = NextResponse.json({ error: "Refresh authentication required" }, { status: 401 });
    response.headers.set("Set-Cookie", clearPlatformCookieHeader());
    response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  let outcome: Awaited<ReturnType<typeof rotateRefreshToken>>;
  try {
    outcome = await rotateRefreshToken("platform", token, {
      ipAddress: clientIpFrom(req),
      userAgent: req.headers.get("user-agent"),
    });
  } catch (error) {
    logError("auth.platform_refresh.failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Session refresh temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (outcome.status !== "rotated") {
    const response = NextResponse.json({ error: "Refresh token is invalid or expired" }, { status: 401 });
    response.headers.set("Set-Cookie", clearPlatformCookieHeader());
    response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const response = NextResponse.json({
    ok: true,
    expiresAt: outcome.pair.accessExpiresAt.toISOString(),
  });
  response.headers.set("Set-Cookie", platformCookieHeader(outcome.pair.accessToken, outcome.pair.accessExpiresAt));
  response.headers.append("Set-Cookie", platformRefreshCookieHeader(outcome.pair.refreshToken, outcome.pair.refreshExpiresAt));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
