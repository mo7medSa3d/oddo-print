import { NextResponse } from "next/server";
import { validatePlatformOwner, revokePlatformSession, clearPlatformCookieHeader } from "../../../../../lib/platform-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";

export async function POST(req: Request) {
  const claims = await validatePlatformOwner(req);
  if (claims) {
    await revokePlatformSession(claims.jti).catch((err) =>
      logError("platform_logout_session_revoke_failed", { error: err?.message ?? String(err) })
    );

    void writeAuditEvent({
      tenantId: "platform",
      actorType: "platform",
      actorId: claims.userId,
      action: "platform.logout",
      resourceType: "platform_owner",
      resourceId: claims.userId,
    }).catch((err) => logError("audit_write_failed", { error: err?.message ?? String(err) }));
  }

  return NextResponse.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": clearPlatformCookieHeader(),
      },
    }
  );
}
