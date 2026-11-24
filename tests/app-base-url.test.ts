import { describe, expect, it, vi, afterEach } from "vitest";
import { appBaseUrl } from "../src/lib/email";

function req(host: string): Request {
  return new Request("http://placeholder/api/auth/forgot-password", {
    headers: { host },
  });
}

describe("app base URL resolution (S-5)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("uses the configured origin, ignoring Host", () => {
    vi.stubEnv("APP_BASE_URL", "https://print.example.com");
    expect(appBaseUrl(req("evil.test"))).toBe("https://print.example.com");
  });

  it("refuses host-derived URLs without an explicit opt-in", () => {
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("ALLOW_HOST_FALLBACK", "");
    expect(() => appBaseUrl(req("evil.test"))).toThrow(/APP_BASE_URL/);
  });

  it("restores host fallback only with ALLOW_HOST_FALLBACK=1", () => {
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("ALLOW_HOST_FALLBACK", "1");
    const lan = new Request("http://lan.test:3000/api/auth/forgot-password");
    expect(appBaseUrl(lan)).toBe("http://lan.test:3000");
  });
});
