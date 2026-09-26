import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindFirst = vi.fn();
const reserveAuthAttempt = vi.fn();

vi.mock("../src/db", () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => userFindFirst(...args),
      },
    },
  },
}));

vi.mock("../src/lib/password", () => ({
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  validEmail: () => true,
  generateOpaqueToken: () => "token",
  hashPassword: vi.fn(),
  hashToken: vi.fn(),
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

  it("tells an already registered email to sign in", async () => {
    userFindFirst.mockResolvedValue({ id: "usr_existing", emailVerifiedAt: new Date() });

    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "existing@example.com", password: "correct-horse-battery-staple" }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "An account with this email already exists. You can sign in instead.",
      code: "ACCOUNT_EXISTS",
    });
  });
});
