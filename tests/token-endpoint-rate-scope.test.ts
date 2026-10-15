import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/lib/password";

const limit = vi.hoisted(() => vi.fn(async () => ({ allowed: true, limit: 5, remaining: 4, resetAtEpochSec: 99 })));
vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: (request: Request) => request.headers.get("x-test-client-ip") ?? "unknown",
  reserveAuthAttempt: limit,
  recordAuthSuccess: vi.fn(),
  setRateLimitHeaders: (response: Response) => response,
}));
vi.mock("../src/db", () => ({ db: { query: {
  emailVerificationTokens: { findFirst: async () => undefined },
  passwordResetTokens: { findFirst: async () => undefined },
  tenantInvitations: { findFirst: async () => undefined },
} } }));

import { POST as verifyEmail } from "../src/app/api/auth/verify-email/route";
import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";
import { POST as acceptInvitation } from "../src/app/api/team/invitations/accept/route";

const endpoints = [
  ["verify-email-token", verifyEmail],
  ["reset-password-token", resetPassword],
  ["invitation-token", acceptInvitation],
] as const;

function request(token: string, ip?: string) {
  return new Request("https://gateway.example.test/api/token-action", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-test-client-ip": ip } : {}) },
    body: JSON.stringify({ token, email: "person@example.test", password: "new-password-1234" }),
  });
}

describe("token-action throttles never create one global endpoint lockout", () => {
  beforeEach(() => limit.mockClear());

  it.each(endpoints)("%s keeps source guessing bounded without blocking another source", async (prefix, post) => {
    expect((await post(request("first-opaque-token", "198.51.100.10"))).status).toBe(400);
    expect((await post(request("second-opaque-token", "198.51.100.10"))).status).toBe(400);
    expect((await post(request("first-opaque-token", "198.51.100.11"))).status).toBe(400);
    expect(limit.mock.calls).toEqual([
      ["198.51.100.10", `${prefix}:198.51.100.10`],
      ["198.51.100.10", `${prefix}:198.51.100.10`],
      ["198.51.100.11", `${prefix}:198.51.100.11`],
    ]);
  });

  it.each(endpoints)("%s fences one opaque token when source is unknown", async (prefix, post) => {
    await post(request("first-opaque-token"));
    await post(request("first-opaque-token"));
    await post(request("second-opaque-token"));
    const first = await hashToken("first-opaque-token");
    const second = await hashToken("second-opaque-token");
    expect(limit.mock.calls).toEqual([
      ["unknown", `${prefix}:${first}`],
      ["unknown", `${prefix}:${first}`],
      ["unknown", `${prefix}:${second}`],
    ]);
    expect(JSON.stringify(limit.mock.calls)).not.toContain("first-opaque-token");
  });
});
