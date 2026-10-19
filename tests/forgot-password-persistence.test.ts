import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), transaction: vi.fn(), email: vi.fn(), log: vi.fn() }));
vi.mock("../src/db", () => ({ db: { query: { users: { findFirst: mocks.lookup } }, transaction: mocks.transaction } }));
vi.mock("../src/lib/auth-rate-limit", () => ({ clientIpFrom: () => "198.51.100.10",
  reserveAuthAttempt: async () => ({ allowed: true }), setRateLimitHeaders: (response: Response) => response }));
vi.mock("../src/lib/email", () => ({ appBaseUrl: () => "https://gateway.test", sendTransactionalEmail: mocks.email }));
vi.mock("../src/lib/log", () => ({ logError: mocks.log }));
vi.mock("../src/i18n/server", () => ({ getServerLocale: async () => "en", makeT: () => (key: string) => key }));
import { POST } from "../src/app/api/auth/forgot-password/route";

function request() {
  return new Request("https://gateway.test/api/auth/forgot-password", {
    method: "POST", body: JSON.stringify({ email: "user@example.test" }),
  });
}

describe("password reset persistence failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue({ id: "user-1", email: "user@example.test" });
    mocks.transaction.mockResolvedValue(undefined);
    mocks.email.mockResolvedValue(undefined);
  });

  it.each(["lookup", "transaction"] as const)("keeps %s failures indistinguishable from absent accounts and sends no unpersisted token", async stage => {
    mocks[stage].mockRejectedValueOnce(new Error("database unavailable"));
    const failed = await POST(request());
    const failedBody = await failed.json();
    expect(failed.status).toBe(202);
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      `auth.forgot_password.${stage === "lookup" ? "lookup" : "persistence"}_failed`,
      { error: "database unavailable" },
    );
    mocks.lookup.mockResolvedValueOnce(undefined);
    const absent = await POST(request());
    expect(absent.status).toBe(failed.status);
    expect(await absent.json()).toEqual(failedBody);
  });

  it("emails the reset link only after successful persistence", async () => {
    expect((await POST(request())).status).toBe(202);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.email.mock.invocationCallOrder[0]);
  });
});
