import type * as NextServerModule from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), transaction: vi.fn(), email: vi.fn(), log: vi.fn() }));
const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", async importActual => ({
  ...await importActual<typeof NextServerModule>(),
  // Model Next's response-lifecycle boundary explicitly. Tests release these
  // callbacks after observing the response and still execute actual delivery.
  after: (callback: () => Promise<void>) => { afterCallbacks.push(callback); },
}));
vi.mock("../src/db", () => ({ db: { query: { users: { findFirst: mocks.lookup } }, transaction: mocks.transaction } }));
vi.mock("../src/lib/auth-rate-limit", () => ({ clientIpFrom: () => "198.51.100.10",
  reserveAuthAttempt: async () => ({ allowed: true }),
  // v1/v3: forgot-password now reserves the scoped bucket, not the shared login bucket.
  reserveScopedAuthAttempt: async () => ({ allowed: true }), setRateLimitHeaders: (response: Response) => response }));
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
    afterCallbacks.length = 0;
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
    expect(afterCallbacks).toHaveLength(0);
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
    expect(mocks.email).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.email.mock.invocationCallOrder[0]);
  });

  it("returns the same accepted response for known and absent accounts while provider delivery is unresolved", async () => {
    let releaseProvider!: () => void;
    const provider = new Promise<void>(resolve => { releaseProvider = resolve; });
    mocks.email.mockReturnValueOnce(provider);
    let response: Response | undefined;
    const pending = POST(request()).then(value => { response = value; return value; });
    let delivery: Promise<unknown> | undefined;
    try {
      // Allow all resolved request/body/database microtasks to finish without
      // resolving the controlled provider promise or waiting for a timeout.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(response, "HTTP response must not wait for the account-dependent provider call").toBeDefined();
      expect(response!.status).toBe(202);
      expect(response!.headers.get("set-cookie")).toBeNull();
      expect(mocks.transaction).toHaveBeenCalledOnce();
      delivery = Promise.all(afterCallbacks.map(callback => callback()));
      await Promise.resolve();
      expect(mocks.email).toHaveBeenCalledOnce();
      mocks.lookup.mockResolvedValueOnce(undefined);
      const absent = await POST(request());
      expect(absent.status).toBe(response!.status);
      expect(await absent.json()).toEqual(await response!.json());
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.email).toHaveBeenCalledOnce();
    } finally {
      releaseProvider();
      await pending;
      await delivery;
    }
  });

  it("does not return success or schedule delivery before the token transaction commits", async () => {
    let commit!: () => void;
    mocks.transaction.mockImplementationOnce(() => new Promise<void>(resolve => { commit = resolve; }));
    let response: Response | undefined;
    const pending = POST(request()).then(value => { response = value; return value; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(response).toBeUndefined();
      expect(afterCallbacks).toHaveLength(0);
      expect(mocks.email).not.toHaveBeenCalled();
    } finally {
      commit();
      await pending;
    }
    expect(response!.status).toBe(202);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mocks.email).toHaveBeenCalledOnce();
  });

  it("records post-response provider failure without changing the accepted response", async () => {
    mocks.email.mockRejectedValueOnce(new Error("Synthetic provider unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(mocks.email).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    expect(mocks.log).toHaveBeenCalledWith("auth.forgot_password.reset_email_failed", { error: "Synthetic provider unavailable" });
    expect(await response.json()).toEqual({ ok: true, message: "If the account exists, a password reset email will be sent." });
  });
});
