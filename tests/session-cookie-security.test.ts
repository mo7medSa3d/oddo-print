import { afterEach, describe, expect, it } from "vitest";
import { sessionCookieSecure } from "../src/lib/session-config";

const originalNodeEnv = process.env.NODE_ENV;
const originalCookieSecure = process.env.COOKIE_SECURE;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalCookieSecure === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = originalCookieSecure;
});

describe("session cookie transport security", () => {
  it("cannot be disabled by COOKIE_SECURE=0 in production", () => {
    process.env.NODE_ENV = "production";
    process.env.COOKIE_SECURE = "0";
    expect(sessionCookieSecure()).toBe(true);
  });

  it("keeps the explicit insecure override available only outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.COOKIE_SECURE = "0";
    expect(sessionCookieSecure()).toBe(false);
    process.env.COOKIE_SECURE = "1";
    expect(sessionCookieSecure()).toBe(true);
  });
});
