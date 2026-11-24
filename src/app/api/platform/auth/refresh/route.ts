import { clearLegacySessionCookies } from "../../../../../lib/session-config";
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
  refreshFailureCode,
  rotateRefreshTokenDetailed,
} from "../../../../../lib/session-tokens";
import { logError } from "../../../../../lib/log";
import { getServerLocale } from "../../../../../i18n/server";

export async function POST(req: Request) {
  const token = getRefreshTokenFromRequest(req, "platform");
  if (!token) {
    const response = NextResponse.json({ error: "Refresh authentication required", code: "REFRESH_TOKEN_REQUIRED" }, { status: 401 });
    response.headers.set("Set-Cookie", clearPlatformCookieHeader());
    response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
    response.headers.set("Cache-Control", "no-store");
    clearLegacySessionCookies(response.headers, "platform");
    return response;
  }

  let outcome: Awaited<ReturnType<typeof rotateRefreshTokenDetailed>>;
  try {
    outcome = await rotateRefreshTokenDetailed("platform", token, {
      ipAddress: clientIpFrom(req),
      userAgent: req.headers.get("user-agent"),
      locale: await getServerLocale(),
    });
  } catch (error) {
    logError("auth.platform_refresh.failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Session refresh temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (outcome.status !== "rotated") {
    const code = refreshFailureCode(outcome);
    const response = NextResponse.json({
      error: code === "SESSION_IDLE_EXPIRED" ? "Session expired due to inactivity" : "Refresh token is invalid or expired",
      code,
    }, { status: 401 });
    response.headers.set("Set-Cookie", clearPlatformCookieHeader());
    response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
    response.headers.set("Cache-Control", "no-store");
    clearLegacySessionCookies(response.headers, "platform");
    return response;
  }

  const response = NextResponse.json({
    ok: true,
    expiresAt: outcome.pair.accessExpiresAt.toISOString(),
  });
  response.headers.set("Set-Cookie", platformCookieHeader(outcome.pair.accessToken, outcome.pair.accessExpiresAt));
  response.headers.append("Set-Cookie", platformRefreshCookieHeader(outcome.pair.refreshToken, outcome.pair.refreshExpiresAt));
  response.headers.set("Cache-Control", "no-store");
  clearLegacySessionCookies(response.headers, "platform");
  return response;
}
