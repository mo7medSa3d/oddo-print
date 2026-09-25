import { NextResponse } from "next/server";
import {
  clearManagerCookieHeader,
  clearManagerRefreshCookieHeader,
  revokeManagerSession,
  validateManagerOnly,
} from "../../../../../lib/manager-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";
import {
  getRefreshTokenFromRequest,
  revokeRefreshTokenFamily,
  revokeSessionFamily,
} from "../../../../../lib/session-tokens";

export async function POST(req: Request) {
  const claims = await validateManagerOnly(req);
  const refreshToken = getRefreshTokenFromRequest(req, "manager");
  let revokeFailed = false;

  try {
    if (claims?.familyId) {
      await revokeSessionFamily(claims.familyId, "logout");
    } else if (refreshToken) {
      await revokeRefreshTokenFamily("manager", refreshToken, "logout");
    } else if (claims) {
      await revokeManagerSession(claims.jti);
    }
  } catch (error) {
    revokeFailed = true;
    logError("auth.manager_logout.session_revoke_failed", {
      jti: claims?.jti,
      familyId: claims?.familyId,
      tenantId: claims?.tenantId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }

  if (claims && !revokeFailed) {
    await writeAuditEvent({
      tenantId: claims.tenantId,
      actorType: claims.userId ? "user" : "system",
      actorId: claims.userId ?? "legacy-manager",
      action: "session.revoked",
      resourceType: claims.familyId ? "refresh_token_family" : "manager_session",
      resourceId: claims.familyId ?? claims.jti,
    }).catch((err) => logError("audit_write_failed", {
      error: err?.message ?? String(err),
    }));
  }

  const response = NextResponse.json(
    revokeFailed
      ? { ok: false, error: "Logout temporarily unavailable" }
      : { ok: true },
    { status: revokeFailed ? 503 : 200 },
  );
  response.headers.set("Set-Cookie", clearManagerCookieHeader());
  response.headers.append("Set-Cookie", clearManagerRefreshCookieHeader());
  response.headers.set("Cache-Control", "no-store");
  return response;
}
