import { NextResponse } from "next/server";
import {
  validatePlatformOwner,
  revokePlatformSession,
  clearPlatformCookieHeader,
  clearPlatformRefreshCookieHeader,
} from "../../../../../lib/platform-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";
import { getRefreshTokenFromRequest, revokeRefreshTokenFamily, revokeSessionFamily } from "../../../../../lib/session-tokens";

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
  } catch (err) {
    revokeFailed = true;
    logError("platform_logout_session_revoke_failed", { jti: claims?.jti, familyId: claims?.familyId, error: err instanceof Error ? err.message : "unknown" });
  }

  if (claims && !revokeFailed) {
    await writeAuditEvent({
      tenantId: null,
      actorType: "platform",
      actorId: claims.userId,
      action: "platform.logout",
      resourceType: "platform_owner",
      resourceId: claims.userId,
    }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));
  }

  if (revokeFailed) {
    return NextResponse.json({ ok: false, error: "Logout temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
      logError("platform_logout_session_revoke_failed", {
        jti: claims.jti,
        familyId: claims.familyId,
        error: err?.message ?? String(err),
      })
    );

    void writeAuditEvent({
      tenantId: null,
      actorType: "platform",
      actorId: claims.userId,
      action: "platform.logout",
      resourceType: "platform_owner",
      resourceId: claims.userId,
    }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));
  }

  const response = NextResponse.json({ ok: true }, {
    headers: {
      "Set-Cookie": clearPlatformCookieHeader(),
    },
  });
  response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
  response.headers.set("Cache-Control", "no-store");
  return response;
}
