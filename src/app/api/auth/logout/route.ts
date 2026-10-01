import { NextResponse } from "next/server";
import { validateCustomer } from "../../../../lib/customer-auth";
import { validateManager } from "../../../../lib/manager-auth";
import {
  clearCustomerRefreshCookie,
  clearCustomerSessionCookie,
} from "../../../../lib/customer-auth";
import { clearManagerCookieHeader, clearManagerRefreshCookieHeader, revokeManagerSession } from "../../../../lib/manager-auth";
import { writeAuditEvent } from "../../../../lib/audit";
import { logError } from "../../../../lib/log";
import {
  getRefreshTokenFromRequest,
  revokeRefreshTokenFamily,
  revokeSessionFamily,
} from "../../../../lib/session-tokens";

export async function POST(req: Request) {
  const customerClaims = await validateCustomer(req);
  const managerClaims = await validateManager(req);
  const customerRefreshToken = getRefreshTokenFromRequest(req, "customer");
  const managerRefreshToken = getRefreshTokenFromRequest(req, "manager");
  let revokeFailed = false;

  const revokeCustomerSession = async () => {
    if (customerClaims?.kind === "customer" && customerClaims.familyId) {
      await revokeSessionFamily(customerClaims.familyId, "logout");
      return customerClaims;
    }
    if (customerRefreshToken) {
      await revokeRefreshTokenFamily("customer", customerRefreshToken, "logout");
      return customerClaims?.kind === "customer" ? customerClaims : null;
    }
    return null;
  };

  const revokeManagerSessionIfPresent = async () => {
    if (managerClaims?.kind === "manager" && managerClaims.familyId) {
      await revokeSessionFamily(managerClaims.familyId, "logout");
      return managerClaims;
    }
    if (managerRefreshToken) {
      await revokeRefreshTokenFamily("manager", managerRefreshToken, "logout");
      return managerClaims?.kind === "manager" ? managerClaims : null;
    }
    if (managerClaims) {
      await revokeManagerSession(managerClaims.jti);
      return managerClaims;
    }
    return null;
  };

  const auditClaims: Array<Awaited<ReturnType<typeof revokeCustomerSession>> | Awaited<ReturnType<typeof revokeManagerSessionIfPresent>>> = [];
  try {
    auditClaims.push(await revokeCustomerSession());
  } catch (error) {
    revokeFailed = true;
    logError("auth.logout.customer_session_revoke_failed", {
      jti: customerClaims?.jti,
      familyId: customerClaims?.familyId,
      tenantId: customerClaims?.tenantId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }

  try {
    auditClaims.push(await revokeManagerSessionIfPresent());
  } catch (error) {
    revokeFailed = true;
    logError("auth.logout.manager_session_revoke_failed", {
      jti: managerClaims?.jti,
      familyId: managerClaims?.familyId,
      tenantId: managerClaims?.tenantId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }

  for (const claims of auditClaims) {
    if (!claims) continue;
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

  // Generic browser logout clears every browser session cookie because the
  // endpoint intentionally represents "log out" rather than a single auth
  // surface. Both corresponding refresh families were independently revoked
  // above, so clearing both cookie pairs cannot leave a recoverable session
  // behind.
  response.headers.set("Set-Cookie", clearCustomerSessionCookie());
  response.headers.append("Set-Cookie", clearCustomerRefreshCookie());
  response.headers.append("Set-Cookie", clearManagerCookieHeader());
  response.headers.append("Set-Cookie", clearManagerRefreshCookieHeader());

  response.headers.set("Cache-Control", "no-store");
  return response;
}
