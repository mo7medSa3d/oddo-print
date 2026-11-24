import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/auth-rate-limit", () => {
  const rateLimitStoreError = new Error("postgres rate-limit store unavailable");
  return {
  clientIpFrom: vi.fn(() => "198.51.100.10"),
  reserveAuthAttempt: vi.fn().mockRejectedValue(rateLimitStoreError),
  recordAuthSuccess: vi.fn(),
  setRateLimitHeaders: vi.fn((response: Response) => response),
  };
});

import { POST as managerLogin } from "../src/app/api/auth/manager/login/route";
import { POST as platformLogin } from "../src/app/api/platform/auth/login/route";
import { POST as customerLogin } from "../src/app/api/auth/login/route";
import { POST as forgotPassword } from "../src/app/api/auth/forgot-password/route";
import { POST as register } from "../src/app/api/auth/register/route";
import { POST as resendVerification } from "../src/app/api/auth/resend-verification/route";

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("auth rate-limit storage failure mode", () => {
  it.each([
    ["manager login", managerLogin, "/api/auth/manager/login", { username: "manager", password: "valid-password" }],
    ["platform login", platformLogin, "/api/platform/auth/login", { email: "owner@example.test", password: "valid-password" }],
    ["customer login", customerLogin, "/api/auth/login", { email: "user@example.test", password: "valid-password" }],
    ["forgot password", forgotPassword, "/api/auth/forgot-password", { email: "user@example.test" }],
    ["register", register, "/api/auth/register", { email: "new@example.test", password: "ValidPassword123!" }],
    ["resend verification", resendVerification, "/api/auth/resend-verification", { email: "user@example.test" }],
  ])("fails closed for %s", async (_name, handler, path, body) => {
    const response = await handler(jsonRequest(path, body));
    expect(response.status).toBe(503);
  });
});
