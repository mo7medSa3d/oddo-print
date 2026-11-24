import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: vi.fn(), reset: vi.fn(), insert: vi.fn(), transaction: vi.fn(),
  hashPassword: vi.fn(async () => "argon2id$screening-fixture"),
}));
vi.mock("../src/db", () => ({ db: {
  query: { users: { findFirst: state.user }, passwordResetTokens: { findFirst: state.reset },
    tenantUsers: { findFirst: vi.fn(async () => null) } },
  transaction: state.transaction,
} }));
vi.mock("../src/lib/password", () => ({
  normalizeEmail: (v: string) => v.trim().toLowerCase(), validEmail: () => true,
  generateOpaqueToken: () => "unrelated-verification-token", hashToken: async () => "token-hash",
  hashPassword: state.hashPassword,
}));
vi.mock("../src/lib/invitation-join", () => ({ findActiveInvitation: vi.fn() }));
vi.mock("../src/lib/email", () => ({ appBaseUrl: () => "https://gateway.test", sendTransactionalEmail: vi.fn() }));
vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "127.0.0.1", reserveAuthAttempt: async () => ({ allowed: true }),
  recordAuthSuccess: async () => undefined, setRateLimitHeaders: (r: Response) => r,
}));
vi.mock("../src/lib/manager-auth", () => ({ revokeLegacyManagerSessionsForUserInTransaction: vi.fn() }));
vi.mock("../src/lib/platform-auth", () => ({ revokeLegacyPlatformSessionsForUserInTransaction: vi.fn() }));
vi.mock("../src/lib/session-tokens", () => ({ revokeUserRefreshFamiliesInTransaction: vi.fn() }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: vi.fn() }));

import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";

const candidate = "yaseir-breached-fixture-2026";
const suffix = createHash("sha1").update(candidate).digest("hex").toUpperCase().slice(5);
const request = (endpoint: string) => new Request(`https://gateway.test/api/auth/${endpoint}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "person@example.test", token: "reset-proof", password: candidate }),
});

describe("compromised-password policy at credential creation boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user.mockResolvedValue(null);
    state.reset.mockResolvedValue({ id: "reset-id", userId: "user-id" });
    state.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      insert: () => ({ values: state.insert }),
      execute: async () => ({ rows: [] }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "user-id" }] }) }) }),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${suffix}:6\r\n${"0".repeat(35)}:0\r\n`)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a breached reset password without consuming the reset proof or changing sessions", async () => {
    const response = await resetPassword(request("reset-password"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
    expect(state.hashPassword).not.toHaveBeenCalled();
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it.each([resetPassword])("fails closed when the breach service is unavailable without exposing provider errors", async (handler) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`provider-secret-${candidate}`); }));
    const response = await handler(request("register"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(candidate);
    expect(state.hashPassword).not.toHaveBeenCalled();
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it.each([resetPassword])("rejects fewer than twelve Unicode code points before screening or mutation", async (handler) => {
    state.user.mockResolvedValue({ id: "existing", emailVerifiedAt: new Date() });
    for (const password of ["😀".repeat(6), "Ab9!?xyZ😃🧪🔐"]) {
      const response = await handler(new Request("https://gateway.test/api/auth/credential", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "person@example.test", token: "reset-proof", password }),
      }));
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(state.hashPassword).not.toHaveBeenCalled();
    expect(state.transaction).not.toHaveBeenCalled();
  });
});
