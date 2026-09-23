const executeMock = vi.fn().mockResolvedValue({ rows: [{ now_sec: "1790208000" }] });

vi.mock("../src/db", () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTenantSelectionToken,
  verifyTenantSelectionToken,
} from "../src/lib/customer-auth";

describe("Tenant Selection Token Contract", () => {
  beforeEach(() => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-at-least-32-chars-long-for-jwt-signing";
    executeMock.mockClear();
  });

  it("creates and verifies a valid selection token", async () => {
    const token = await createTenantSelectionToken("usr_123456789012345678", "user@example.com");
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3);

    const claims = await verifyTenantSelectionToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("tenant_selection");
    expect(claims?.userId).toBe("usr_123456789012345678");
    expect(claims?.email).toBe("user@example.com");
    expect(claims?.jti.startsWith("tsel_")).toBe(true);
  });

  it("rejects tampered selection token", async () => {
    const token = createTenantSelectionToken("usr_123456789012345678", "user@example.com");
    const [h, p] = token.split(".");
    const tampered = `${h}.${p}.invalid_signature`;
    const claims = await verifyTenantSelectionToken(tampered);
    expect(claims).toBeNull();
  });

  it("rejects token with modified payload", async () => {
    const token = createTenantSelectionToken("usr_123456789012345678", "user@example.com");
    const [h, , s] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "tenant_selection", userId: "usr_attacker", email: "hacker@example.com", jti: "tsel_123", iat: Date.now() / 1000, exp: Date.now() / 1000 + 300 })
    ).toString("base64url");
    const tampered = `${h}.${forgedPayload}.${s}`;
    const claims = verifyTenantSelectionToken(tampered);
    expect(claims).toBeNull();
  });

  it("rejects malformed strings", async () => {
    await expect(verifyTenantSelectionToken("")).resolves.toBeNull();
    await expect(verifyTenantSelectionToken("invalid")).resolves.toBeNull();
    await expect(verifyTenantSelectionToken("a.b")).resolves.toBeNull();
    await expect(verifyTenantSelectionToken("a.b.c.d")).resolves.toBeNull();
  });
});
