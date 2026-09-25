import { NextResponse } from "next/server";
import {
  clearPlatformCookieHeader,
  clearPlatformRefreshCookieHeader,
  revokePlatformSession,
  validatePlatformOwner,
} from "../../../../../lib/platform-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";
import {
  getRefreshTokenFromRequest,
  revokeRefreshTokenFamily,
  revokeSessionFamily,
} from "../../../../../lib/session-tokens";

export async function POST(req: Request) {
  const claims = await validatePlatformOwner(req);
  const refreshToken = getRefreshTokenFromRequest(req, "platform");
  let revokeFailed = false;

  try {
    if (claims?.familyId) {
      await revokeSessionFamily(claims.familyId, "logout");
    } else if (refreshToken) {
      await revokeRefreshTokenFamily("platform", refreshToken, "logout");
    } else if (claims) {
      await revokePlatformSession(claims.jti);
    }
  } catch (error) {
    revokeFailed = true;
    logError("platform_logout_session_revoke_failed", {
      jti: claims?.jti,
      familyId: claims?.familyId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }

  if (claims && !revokeFailed) {
    await writeAuditEvent({
      tenantId: null,
      actorType: "platform",
      actorId: claims.userId,
      action: "platform.logout",
      resourceType: claims.familyId ? "refresh_token_family" : "platform_owner",
      resourceId: claims.familyId ?? claims.userId,
    }).catch((err) => logError("audit_write_failed", {
      error: err?.message ?? String(err),
    }));
  }

  const response = NextResponse.json(
    revokeFailed
      ? { ok: false, error: "Logout temporarily unavailable" }
      : { ok: true },
    {
      status: revokeFailed ? 503 : 200,
      headers: {
        "Set-Cookie": clearPlatformCookieHeader(),
        "Cache-Control": "no-store",
      },
    },
  );
  response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
  return response;
}
