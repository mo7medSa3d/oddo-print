import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLegacySessionCookies, sessionCookieSecure } from "../src/lib/session-config";
import { accessCookieHeader, refreshCookieHeader, getAccessTokenFromRequest, getRefreshTokenFromRequest } from "../src/lib/session-tokens";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session cookie transport security", () => {
  it("cannot be disabled by COOKIE_SECURE=0 in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECURE", "0");
    expect(sessionCookieSecure()).toBe(true);
  });

  it("keeps the explicit insecure override available only outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("COOKIE_SECURE", "0");
    expect(sessionCookieSecure()).toBe(false);
    vi.stubEnv("COOKIE_SECURE", "1");
    expect(sessionCookieSecure()).toBe(true);
  });

  it("uses production cookie prefixes and refuses unprefixed or duplicate-cookie shadowing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECURE", "0");
    const exp = new Date(Date.now() + 900000);
    for (const [kind, base] of [["customer", "cust"], ["manager", "mgr"], ["platform", "plt"]] as const) {
      const access = accessCookieHeader(kind, "access", exp);
      expect(access).toMatch(new RegExp(`^__Host-${base}_session=access; Path=/; HttpOnly; SameSite=Lax; Secure;`));
      expect(access).not.toMatch(/; Domain=/i);
      expect(refreshCookieHeader(kind, "refresh", exp)).toMatch(new RegExp(`^__Host-${base}_refresh=refresh; Path=/; HttpOnly; SameSite=Strict; Secure;`));
      expect(getRefreshTokenFromRequest(new Request("https://gateway.test", { headers: { cookie: `__Secure-${base}_refresh=old` } }), kind)).toBeNull();
      expect(getAccessTokenFromRequest(new Request("https://gateway.test", { headers: { cookie: `${base}_session=old` } }), kind)).toBeNull();
      expect(getRefreshTokenFromRequest(new Request("https://gateway.test", { headers: { cookie: `${base}_refresh=old` } }), kind)).toBeNull();
      expect(getAccessTokenFromRequest(new Request("https://gateway.test", { headers: { cookie: `__Host-${base}_session=real; ${base}_session=shadow` } }), kind)).toBe("real");
      expect(getAccessTokenFromRequest(new Request("https://gateway.test", { headers: { cookie: `__Host-${base}_session=one; __Host-${base}_session=two` } }), kind)).toBeNull();
    }
    const headers = new Headers();
    clearLegacySessionCookies(headers, "platform");
    expect(headers.getSetCookie()).toHaveLength(3);
    expect(headers.getSetCookie().every(value => value.includes("Max-Age=0") && value.includes("Secure") && !value.startsWith("__Host-"))).toBe(true);
    expect(headers.getSetCookie()).toContainEqual(expect.stringContaining("plt_refresh=; Path=/api/platform/auth;"));
  });
});
