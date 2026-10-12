import { describe, expect, it, vi, afterEach } from "vitest";
import { clientIpFrom } from "../src/lib/auth-rate-limit";

function reqWithXff(xff: string): Request {
  return new Request("http://localhost/api/auth/login", { headers: { "x-forwarded-for": xff } });
}

describe("forwarded client IP selection (S-1)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("prefers the last valid entry so spoofed leftmost values are ignored", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(clientIpFrom(reqWithXff("1.1.1.1, 2.2.2.2"))).toBe("2.2.2.2");
    expect(clientIpFrom(reqWithXff("spoofed, 3.3.3.3"))).toBe("3.3.3.3");
  });

  it("returns unknown without a trusted proxy", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    expect(clientIpFrom(reqWithXff("9.9.9.9"))).toBe("unknown");
  });
});
