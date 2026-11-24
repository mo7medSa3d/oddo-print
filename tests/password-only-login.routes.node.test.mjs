/** Actual route functions with credential/store boundaries replaced. Database
 * end-to-end coverage lives in password-only-auth.integration.test.ts. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const pair = { token: "access-fixture", accessToken: "access-fixture", refreshToken: "refresh-fixture", exp: new Date("2030-01-01T00:15:00Z"),
  accessExpiresAt: new Date("2030-01-01T00:15:00Z"), refreshExpiresAt: new Date("2030-01-01T08:00:00Z"), familyId: "a".repeat(32) };
const cookie = (name) => () => `${name}=fixture; HttpOnly; SameSite=Strict`;
class AuthenticationChangedError extends Error {}

function handler(file, role, recoverInvitation = false) {
  const identity = { userId: "user", email: "user@example.test", credentialVersion: "b".repeat(64),
    ...(recoverInvitation ? { memberships: [], multipleTenants: false } : { tenantId: "tenant", role }) };
  const modules = {
    "next/server": { NextResponse: Response },
    "auth-rate-limit": { clientIpFrom: () => "unknown", reserveAuthAttempt: async () => ({ allowed: true }), recordAuthSuccess: async () => {}, setRateLimitHeaders: r => r },
    "request-limits": { hasBodyOverLimit: () => false },
    "session-config": { clearLegacySessionCookies: () => {} },
    "log": { logError: () => {}, logWarn: () => {}, logInfo: () => {}, requestIdFrom: () => "test-request" },
    "audit": { writeAuditEvent: async () => {} },
    "customer-auth": { authenticateForTenant: async () => identity, issueCustomerSession: async () => pair,
      customerSessionCookie: cookie("cust_session"), customerRefreshCookie: cookie("cust_refresh") },
    "invitation-join": { joinInvitationWithPassword: async (token, principal) => {
      assert.equal(recoverInvitation, true, "ordinary password login must not consume an invitation");
      assert.equal(token, "offer-fixture");
      assert.equal(principal, identity, "only the authenticated credential snapshot may join");
      return { membership: { tenantId: "invited", role: "admin" }, session: pair };
    } },
    "manager-auth": { resolveManagerTenantId: async () => "tenant", authenticateManagerUser: async () => identity,
      getManagerUsername: () => null, verifyManagerPassword: async () => false, createManagerSession: async () => pair,
      managerCookieHeader: cookie("mgr_session"), managerRefreshCookieHeader: cookie("mgr_refresh") },
    "platform-auth": { authenticatePlatformOwner: async () => identity, createPlatformSession: async () => pair,
      platformCookieHeader: cookie("plt_session"), platformRefreshCookieHeader: cookie("plt_refresh") },
    "session-tokens": { AuthenticationChangedError, isTrustedDesktopRequest: () => false, sessionReplacementFromRequest: () => ({ accessToken: null, refreshToken: null }) },
    "session-credentials": { environmentManagerCredentialVersion: () => null },
    "runtime-secret": { runtimeSecret: () => undefined },
    "tenant-guard": { TenantDeletedError: class extends Error {}, TenantSuspendedError: class extends Error {} },
    "workspace-session-http": { workspaceSecurityErrorResponse: () => Response.json({ error: "unavailable" }, { status: 503 }) },
    "platform-session-security": { PlatformSessionExpiredError: class extends Error {} },
  };
  let source = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" });
  source = source.replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g, (_all, binding, module) => {
    if (!binding.trim().startsWith("{")) throw new Error("Unexpected route import " + binding);
    return `const ${binding.replace(/\bas\b/g, ":")} = require(${JSON.stringify(module)});`;
  }).replace(/export async function POST\(/, "async function POST(");
  return new Function("require", source + "\nreturn POST;")((name) => {
    const resolved = name === "next/server" ? name : name.split("/").at(-1);
    if (!(resolved in modules)) throw new Error("Unmodelled route boundary " + name);
    return modules[resolved];
  });
}

test("a verified password plus a valid offer recovers an account without a workspace, without MFA or exposed tokens", async () => {
  const post = handler("src/app/api/auth/login/route.ts", "admin", true);
  const response = await post(new Request("http://localhost:3000/api/auth/login", {
    method: "POST", body: JSON.stringify({ email: "user@example.test", password: "correct password fixture", inviteToken: "offer-fixture" }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.invitationAccepted, true);
  assert.equal(body.tenantId, "invited");
  assert.doesNotMatch(JSON.stringify(body), /accessToken|refreshToken|credentialVersion|mfa|challenge|recoveryCodes/i);
  assert.match(response.headers.get("Set-Cookie"), /cust_session=fixture; HttpOnly/);
  assert.match(response.headers.get("Cache-Control"), /no-store/);
});
const roles = ["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"];
for (const tenantId of [null, "", 42, false, [], {}, "x".repeat(129)]) {
  test(`an invalid explicit workspace selector cannot fall back to another workspace: ${JSON.stringify(tenantId)}`, async () => {
    const post = handler("src/app/api/auth/login/route.ts", "owner");
    const response = await post(new Request("http://localhost:3000/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: "user@example.test", password: "correct password fixture", tenantId }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
    assert.equal(response.headers.get("Set-Cookie"), null);
  });
}
for (const kind of ["customer", "manager", "platform"]) {
  for (const role of kind === "platform" ? ["platform_owner"] : roles) {
    test(`${kind} ${role} obtains a session immediately after verified password`, async () => {
      const route = kind === "customer" ? "src/app/api/auth/login/route.ts" : kind === "manager" ? "src/app/api/auth/manager/login/route.ts" : "src/app/api/platform/auth/login/route.ts";
      const post = handler(route, role);
      const response = await post(new Request("http://localhost:3000/api/login", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@example.test", username: "user@example.test", password: "correct password fixture" }) }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.doesNotMatch(JSON.stringify(body), /accessToken|refreshToken|credentialVersion|mfa|challenge|recoveryCodes/i);
      const prefix = kind === "customer" ? "cust" : kind === "manager" ? "mgr" : "plt";
      for (const suffix of ["session", "refresh"]) assert.match(response.headers.get("Set-Cookie"), new RegExp(`${prefix}_${suffix}=fixture; HttpOnly`));
      assert.match(response.headers.get("Cache-Control"), /no-store/);
    });
  }
}
