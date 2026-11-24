import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/customer-auth", () => ({
  validateCustomer: vi.fn().mockRejectedValue(new Error("session store unavailable")),
  clearCustomerSessionCookie: vi.fn(() => "cust_session=; Max-Age=0"),
  clearCustomerRefreshCookie: vi.fn(() => "cust_refresh=; Max-Age=0"),
}));

vi.mock("../src/lib/manager-auth", () => ({
  validateManager: vi.fn().mockRejectedValue(new Error("session store unavailable")),
  clearManagerCookieHeader: vi.fn(() => "mgr_session=; Max-Age=0"),
  clearManagerRefreshCookieHeader: vi.fn(() => "mgr_refresh=; Max-Age=0"),
  revokeManagerSession: vi.fn(),
}));

vi.mock("../src/lib/platform-auth", () => ({
  validatePlatformOwner: vi.fn().mockRejectedValue(new Error("session store unavailable")),
  clearPlatformCookieHeader: vi.fn(() => "plt_session=; Max-Age=0"),
  clearPlatformRefreshCookieHeader: vi.fn(() => "plt_refresh=; Max-Age=0"),
  revokePlatformSession: vi.fn(),
}));

vi.mock("../src/lib/session-tokens", () => ({
  getRefreshTokenFromRequest: vi.fn(() => null),
  revokeRefreshTokenFamily: vi.fn(),
  revokeSessionFamily: vi.fn(),
}));

vi.mock("../src/lib/audit", () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock("../src/lib/log", () => ({
  logError: vi.fn(),
}));

import { POST as genericLogout } from "../src/app/api/auth/logout/route";
import { POST as managerLogout } from "../src/app/api/auth/manager/logout/route";
import { POST as platformLogout } from "../src/app/api/platform/auth/logout/route";

function request(path: string): Request {
  return new Request(`http://gateway.test${path}`, { method: "POST" });
}

describe("logout cookie clearing when durable session validation is unavailable", () => {
  it.each([
    ["generic", genericLogout, "/api/auth/logout", ["cust_session=", "cust_refresh=", "mgr_session=", "mgr_refresh="]],
    ["manager", managerLogout, "/api/auth/manager/logout", ["mgr_session=", "mgr_refresh="]],
    ["platform", platformLogout, "/api/platform/auth/logout", ["plt_session=", "plt_refresh="]],
  ])("%s logout still clears browser credentials", async (_name, handler, path, cookies) => {
    const response = await handler(request(path));
    expect(response.status).toBe(503);
    const setCookie = response.headers.get("set-cookie") ?? "";
    for (const cookie of cookies) expect(setCookie).toContain(cookie);
  });
});
