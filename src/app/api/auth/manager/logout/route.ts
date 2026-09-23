import { NextResponse } from "next/server";
import { validateManager, revokeManagerSession, clearManagerCookieHeader } from "../../../../../lib/manager-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  let revokeFailed = false;
  if (claims) {
    try {
      await revokeManagerSession(claims.jti);
    } catch (error) {
      revokeFailed = true;
      logError("auth.manager_logout.session_revoke_failed", { jti: claims.jti, tenantId: claims.tenantId, error: error instanceof Error ? error.message : "unknown" });
    }
    if (!revokeFailed) {
      await writeAuditEvent({
        tenantId: claims.tenantId,
        actorType: claims.userId ? "user" : "system",
        actorId: claims.userId ?? "legacy-manager",
        action: "session.revoked",
        resourceType: "manager_session",
        resourceId: claims.jti,
      }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));
    }
  }
  const res = NextResponse.json(
    revokeFailed ? { ok: false, error: "Logout temporarily unavailable" } : { ok: true },
    { status: revokeFailed ? 503 : 200 },
  );
  res.headers.set("Set-Cookie", clearManagerCookieHeader());
  return res;
}
