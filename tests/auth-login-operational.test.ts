import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "198.51.100.10",
  reserveAuthAttempt: vi.fn(),
  recordAuthSuccess: vi.fn(),
  setRateLimitHeaders: (response: Response) => {
    response.headers.set("X-RateLimit-Remaining", "9");
    return response;
  },
}));
vi.mock("../src/lib/platform-auth", () => ({
  authenticatePlatformOwner: vi.fn(), createPlatformSession: vi.fn(),
  platformCookieHeader: () => "plt_session=fixture; HttpOnly",
  platformRefreshCookieHeader: () => "plt_refresh=fixture; HttpOnly",
}));
vi.mock("../src/lib/manager-auth", () => ({
  resolveManagerTenantId: vi.fn(), authenticateManagerUser: vi.fn(), createManagerSession: vi.fn(),
  getManagerUsername: () => "manager", verifyManagerPassword: async () => false,
  managerCookieHeader: () => "mgr_session=fixture; HttpOnly",
  managerRefreshCookieHeader: () => "mgr_refresh=fixture; HttpOnly",
}));
vi.mock("../src/lib/session-tokens", () => ({
  AuthenticationChangedError: class AuthenticationChangedError extends Error {},
  isTrustedDesktopRequest: () => false, sessionReplacementFromRequest: () => ({ accessToken: null, refreshToken: null }),
}));
vi.mock("../src/lib/runtime-secret", () => ({ runtimeSecret: () => undefined }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));
vi.mock("../src/lib/log", () => ({
  logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn(), requestIdFrom: () => "fixture-request",
}));

import { reserveAuthAttempt, recordAuthSuccess } from "../src/lib/auth-rate-limit";
import { authenticatePlatformOwner, createPlatformSession } from "../src/lib/platform-auth";
import { resolveManagerTenantId, authenticateManagerUser, createManagerSession } from "../src/lib/manager-auth";
import { AuthenticationChangedError } from "../src/lib/session-tokens";
import { logError, logWarn } from "../src/lib/log";
import { POST as platformLogin } from "../src/app/api/platform/auth/login/route";
import { POST as managerLogin } from "../src/app/api/auth/manager/login/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reserveAuthAttempt).mockReset().mockResolvedValue({
    allowed: true, retryAfterSec: 0, remaining: 9, limit: 10, resetAtEpochSec: 1791892800,
  });
  vi.mocked(recordAuthSuccess).mockReset().mockResolvedValue(undefined);
  vi.mocked(authenticatePlatformOwner).mockReset().mockResolvedValue({
    userId: "owner", email: "owner@example.test", credentialVersion: "fixture-version",
  });
  vi.mocked(createPlatformSession).mockReset().mockResolvedValue({
    token: "fixture", jti: "jti-fixture", exp: new Date("2030-01-01T00:15:00Z"), refreshToken: "refresh-fixture",
    refreshTokenId: "id-fixture", familyId: "family-fixture", refreshExpiresAt: new Date("2030-01-01T08:00:00Z"),
  });
  vi.mocked(resolveManagerTenantId).mockReset().mockResolvedValue("tenant-fixture");
});

function request(path: string): Request {
  return new Request(`http://gateway.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", username: "owner@example.test", password: "fixture-password" }),
  });
}

describe("login operational failures preserve authentication semantics", () => {
  it.each(["identity", "session"])("platform %s storage failure returns a logged temporary refusal", async (stage) => {
    const failure = new Error("private database details");
    if (stage === "identity") vi.mocked(authenticatePlatformOwner).mockRejectedValueOnce(failure);
    else vi.mocked(createPlatformSession).mockRejectedValueOnce(failure);
    const response = await platformLogin(request("/api/platform/auth/login"));
    expect(response.status).toBe(503);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).not.toContain(failure.message);
    expect(logError).toHaveBeenCalled();
    if (stage === "identity") expect(createPlatformSession).not.toHaveBeenCalled();
  });

  it("a failed success-bucket clear cannot reject an otherwise valid password-to-session transition", async () => {
    vi.mocked(recordAuthSuccess).mockRejectedValueOnce(new Error("cleanup unavailable"));
    const response = await platformLogin(request("/api/platform/auth/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("plt_session=");
    expect(response.headers.get("Set-Cookie")).toContain("plt_refresh=");
    expect(await response.json()).toMatchObject({ ok: true });
    expect(logWarn).toHaveBeenCalledWith("auth.platform_login.rate_limit_clear_failed", expect.any(Object));
  });

  it("credential changes remain unauthorized rather than operational failures", async () => {
    vi.mocked(createPlatformSession).mockRejectedValueOnce(new AuthenticationChangedError());
    const response = await platformLogin(request("/api/platform/auth/login"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("invalid platform credentials still stop before session issuance", async () => {
    vi.mocked(authenticatePlatformOwner).mockResolvedValueOnce(null);
    expect((await platformLogin(request("/api/platform/auth/login"))).status).toBe(401);
    expect(createPlatformSession).not.toHaveBeenCalled();
  });

  it("logs throttled platform attempts without credentials or an account enumeration signal", async () => {
    vi.mocked(reserveAuthAttempt).mockResolvedValueOnce({ allowed: false, retryAfterSec: 30, remaining: 0, limit: 5, resetAtEpochSec: 1791892800 });
    const response = await platformLogin(request("/api/platform/auth/login"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(authenticatePlatformOwner).not.toHaveBeenCalled();
    expect(createPlatformSession).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("auth.platform_login.rate_limited", { ip: "198.51.100.10", retryAfterSec: 30 });
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toMatch(/fixture-password|owner@example/);
  });

  it("manager tenant lookup outage refuses login before credential or session calls", async () => {
    vi.mocked(resolveManagerTenantId).mockRejectedValueOnce(new Error("private tenant lookup details"));
    const response = await managerLogin(request("/api/auth/manager/login"));
    expect(response.status).toBe(503);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(authenticateManagerUser).not.toHaveBeenCalled();
    expect(createManagerSession).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("auth.login.tenant_lookup_failed", expect.any(Object));
  });
});
