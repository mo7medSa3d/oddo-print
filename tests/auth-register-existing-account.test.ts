import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindFirst = vi.fn();
const reserveAuthAttempt = vi.fn();
const sendEmail = vi.fn();
const insertValues = vi.fn();

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

vi.mock("../src/lib/email", () => ({
  appBaseUrl: () => "https://gateway.test",
  sendTransactionalEmail: (...args: unknown[]) => sendEmail(...args),
}));

vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "127.0.0.1",
  reserveAuthAttempt: (...args: unknown[]) => reserveAuthAttempt(...args),
  setRateLimitHeaders: (response: Response) => response,
}));

import { POST } from "../src/app/api/auth/register/route";

describe("Register API existing-account handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveAuthAttempt.mockResolvedValue({ allowed: true });
  });

  it("returns the same generic accepted response for an existing email", async () => {
    userFindFirst.mockResolvedValue({ id: "usr_existing", emailVerifiedAt: new Date() });

    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "existing@example.com", password: "correct-horse-battery-staple" }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "If the account can be created, a verification email will be sent.",
    });
  });

  it("preserves plan and invitation continuation in the mailbox proof without exposing the signup password", async () => {
    userFindFirst.mockResolvedValue(undefined);
    insertValues.mockResolvedValue(undefined);
    sendEmail.mockResolvedValue(undefined);
    const response = await POST(new Request("https://gateway.test/api/auth/register", {
      method: "POST", body: JSON.stringify({ email: "new@example.test", password: "correct-horse-battery-staple", planId: "selected-plan", inviteToken: "invitation-proof-token" }),
    }));
    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(insertValues).toHaveBeenCalledTimes(2);
    const message = sendEmail.mock.calls[0][0];
    const link = new URL(message.html.match(/href="([^"]+)"/)[1]);
    expect(link.pathname).toBe("/verify-email");
    expect(link.searchParams.get("token")).toBe("token");
    expect(link.searchParams.get("plan")).toBe("selected-plan");
    expect(link.searchParams.get("invite")).toBe("invitation-proof-token");
    expect(JSON.stringify(message)).not.toContain("correct-horse-battery-staple");
  });
});
