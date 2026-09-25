import { NextResponse } from "next/server";
import {
  clearManagerCookieHeader,
  clearManagerRefreshCookieHeader,
  managerCookieHeader,
  managerRefreshCookieHeader,
} from "../../../../../lib/manager-auth";
import { clientIpFrom } from "../../../../../lib/auth-rate-limit";
import {
  getRefreshTokenFromRequest,
  isTrustedDesktopRequest,
  rotateRefreshToken,
} from "../../../../../lib/session-tokens";
import { logError } from "../../../../../lib/log";

export async function POST(req: Request) {
  const desktopClient = isTrustedDesktopRequest(req);
  const token = getRefreshTokenFromRequest(req, "manager");
  if (!token) {
    const response = NextResponse.json({ error: "Refresh authentication required" }, { status: 401 });
    response.headers.set("Set-Cookie", clearManagerCookieHeader());
    response.headers.append("Set-Cookie", clearManagerRefreshCookieHeader());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  let outcome: Awaited<ReturnType<typeof rotateRefreshToken>>;
  try {
    outcome = await rotateRefreshToken("manager", token, {
      ipAddress: clientIpFrom(req),
      userAgent: req.headers.get("user-agent"),
    });
  } catch (error) {
    logError("auth.manager_refresh.failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Session refresh temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (outcome.status !== "rotated") {
    const response = NextResponse.json({ error: "Refresh token is invalid or expired" }, { status: 401 });
    response.headers.set("Set-Cookie", clearManagerCookieHeader());
    response.headers.append("Set-Cookie", clearManagerRefreshCookieHeader());
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const responseBody: { ok: true; expiresAt: string; accessToken?: string; refreshToken?: string } = {
    ok: true,
    expiresAt: outcome.pair.accessExpiresAt.toISOString(),
  };
  if (desktopClient) {
    responseBody.accessToken = outcome.pair.accessToken;
    responseBody.refreshToken = outcome.pair.refreshToken;
  }

  const response = NextResponse.json(responseBody);
  if (!desktopClient) {
    response.headers.set("Set-Cookie", managerCookieHeader(outcome.pair.accessToken, outcome.pair.accessExpiresAt));
    response.headers.append("Set-Cookie", managerRefreshCookieHeader(outcome.pair.refreshToken, outcome.pair.refreshExpiresAt));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
