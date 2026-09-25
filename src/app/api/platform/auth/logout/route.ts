import { NextResponse } from "next/server";
import {
  validatePlatformOwner,
  revokePlatformSession,
  clearPlatformCookieHeader,
  clearPlatformRefreshCookieHeader,
} from "../../../../../lib/platform-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";
import { revokeSessionFamily } from "../../../../../lib/session-tokens";

export async function POST(req: Request) {
  const claims = await validatePlatformOwner(req);
  if (claims) {
    await (claims.familyId
      ? revokeSessionFamily(claims.familyId, "logout")
      : revokePlatformSession(claims.jti)
    ).catch((err) =>
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
