import type * as PasswordScreeningModule from "../src/lib/password-screening";
import type * as NextServerModule from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

// External breach-corpus fixture for these unrelated account/transaction tests.
// Production always screens; password-screening*.test.ts exercise the real
// range protocol, positive matches, privacy, limits and fail-closed behavior.
vi.mock("../src/lib/password-screening", async (importActual) => ({
  ...await importActual<typeof PasswordScreeningModule>(),
  screenNewPassword: vi.fn(async () => "acceptable"),
}));

const userFindFirst = vi.fn();
const reserveAuthAttempt = vi.fn();
const sendEmail = vi.fn();
const insertValues = vi.fn();
const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", async (importActual) => ({
  ...await importActual<typeof NextServerModule>(),
  // Explicit Next request-lifecycle boundary; delivery is exercised when the
  // test releases these post-response callbacks, never bypassed in production.
  after: (callback: () => Promise<void>) => { afterCallbacks.push(callback); },
}));

vi.mock("../src/db", () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => userFindFirst(...args),
      },
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: () => ({ values: insertValues }) }),
  },
}));

vi.mock("../src/lib/password", () => ({
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  validEmail: () => true,
  generateOpaqueToken: () => "token",
  hashPassword: vi.fn(async () => "argon2id$fixture"),
  hashToken: vi.fn(async () => "fixture-token-hash"),
}));

vi.mock("../src/lib/invitation-join", () => ({
  findActiveInvitation: vi.fn(async () => ({ id: "inv_registration_test", email: "new@example.test" })),
}));
vi.mock("../src/lib/email", () => ({
  appBaseUrl: () => "https://gateway.test",
  sendTransactionalEmail: (...args: unknown[]) => sendEmail(...args),
}));

vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "127.0.0.1",
  reserveAuthAttempt: (...args: unknown[]) => reserveAuthAttempt(...args),
  // v1/v3: register now reserves the scoped bucket, not the shared login bucket.
  reserveScopedAuthAttempt: (...args: unknown[]) => reserveAuthAttempt(...args),
  setRateLimitHeaders: (response: Response) => response,
}));

import { POST } from "../src/app/api/auth/register/route";
import { hashPassword } from "../src/lib/password";

describe("Register API existing-account handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    reserveAuthAttempt.mockResolvedValue({ allowed: true });
  });

  it("returns the same generic accepted response for an existing email", async () => {
    userFindFirst.mockResolvedValue({ id: "usr_existing", emailVerifiedAt: new Date() });

    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "existing@example.com" }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "If the account can be created, a verification email will be sent.",
    });
    expect(hashPassword).toHaveBeenCalledExactlyOnceWith("token");
    expect(afterCallbacks).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("preserves plan and invitation continuation in the mailbox proof without exposing the signup password", async () => {
    userFindFirst.mockResolvedValue(undefined);
    insertValues.mockResolvedValue(undefined);
    sendEmail.mockResolvedValue(undefined);
    const response = await POST(new Request("https://gateway.test/api/auth/register", {
      method: "POST", body: JSON.stringify({ email: "new@example.test", displayName: "Owner", planId: "selected-plan", inviteToken: "invitation-proof-token" }),
    }));
    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    const message = sendEmail.mock.calls[0][0];
    const link = new URL(message.html.match(/href="([^"]+)"/)[1]);
    expect(link.pathname).toBe("/verify-email");
    expect(link.searchParams.get("token")).toBe("token");
    expect(link.searchParams.get("plan")).toBe("selected-plan");
    expect(link.searchParams.get("invite")).toBe("invitation-proof-token");
    expect(JSON.stringify(message)).not.toContain("correct-horse-battery-staple");
    expect(insertValues.mock.calls[0][0].passwordHash).toBe("argon2id$fixture");
  });

  it("returns accepted before provider delivery and keeps later delivery failure generic", async () => {
    userFindFirst.mockResolvedValue(undefined);
    insertValues.mockResolvedValue(undefined);
    sendEmail.mockRejectedValueOnce(new Error("Synthetic provider unavailable"));
    const response = await POST(new Request("https://gateway.test/api/auth/register", {
      method: "POST", body: JSON.stringify({ email: "new@example.test" }),
    }));
    expect(response.status).toBe(202);
    expect(hashPassword).toHaveBeenCalledExactlyOnceWith("token");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    await expect(response.json()).resolves.toEqual({ ok: true, message: "If the account can be created, a verification email will be sent." });
  });
});
