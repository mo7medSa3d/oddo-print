import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionCookieSecure } from "../src/lib/session-config";

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
});
