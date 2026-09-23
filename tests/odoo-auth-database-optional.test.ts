import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const { apiKeyFindFirst, apiKeyUpdate, requireActiveTenantOrNull } = vi.hoisted(() => ({
  apiKeyFindFirst: vi.fn(),
  apiKeyUpdate: vi.fn(),
  requireActiveTenantOrNull: vi.fn().mockResolvedValue("active"),
}));

vi.mock("../src/db", () => ({
  db: {
    query: {
      apiKeys: { findFirst: (...args: unknown[]) => apiKeyFindFirst(...args) },
    },
    update: () => ({ set: () => ({ where: (...args: unknown[]) => apiKeyUpdate(...args) }) }),
  },
}));

vi.mock("../src/lib/tenant-guard", () => ({
  requireActiveTenantOrNull,
  TenantSuspendedError: class TenantSuspendedError extends Error {},
  TenantDeletedError: class TenantDeletedError extends Error {},
}));

import { validateOdooKey } from "../src/lib/odoo-auth";

// Odoo Gateway authentication is based on the Odoo installation API key.
// The Odoo database name is not used as an authentication requirement:
// X-Odoo-Database may be sent for informational purposes and is ignored.
describe("Odoo API-key authentication ignores the database name", () => {
  const hash = createHash("sha256").update("odoo_testkey").digest("hex");
  const liveRow = {
    id: "key_a",
    tenantId: "tenant_a",
    hashedKey: hash,
    revokedAt: null,
    readOnlyUntil: null,
    odooEnabled: true,
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    apiKeyFindFirst.mockReset();
    apiKeyUpdate.mockReset().mockResolvedValue(undefined);
    apiKeyFindFirst.mockResolvedValue(liveRow);
  });

  const post = (headers: Record<string, string>) =>
    new Request("https://gateway.test/api/print/jobs", { method: "POST", headers });

  it("accepts a valid key with X-Odoo-Database: odoo-db", async () => {
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("accepts a valid key with a different database name", async () => {
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "anything-else" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("accepts a valid key when X-Odoo-Database is missing", async () => {
    const req = post({ authorization: "Bearer odoo_testkey" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("accepts a valid key via X-Api-Key regardless of database name", async () => {
    const req = post({ "x-api-key": "odoo_testkey", "x-odoo-database": "another-db" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("still performs the API-key lookup even when the database differs", async () => {
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "unrelated-db" });
    await validateOdooKey(req);
    expect(apiKeyFindFirst).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid API key", async () => {
    apiKeyFindFirst.mockResolvedValue(null);
    const req = post({ authorization: "Bearer odoo_wrongkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
  });

  it("rejects a revoked API key", async () => {
    apiKeyFindFirst.mockResolvedValue({ ...liveRow, revokedAt: new Date() });
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
  });

  it("accepts a rotated API key that the database query marks inside the grace window", async () => {
    apiKeyFindFirst.mockResolvedValue({
      ...liveRow,
      revokedAt: new Date("2026-09-24T00:59:59.000Z"),
      readOnlyUntil: new Date("2026-09-24T01:00:01.000Z"),
    });
    const req = post({ authorization: "Bearer odoo_testkey" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a", readOnly: true });
  });

  it("rejects a rotated API key after the database grace window", async () => {
    apiKeyFindFirst.mockResolvedValue(null);
    const req = post({ authorization: "Bearer odoo_testkey" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
  });

  it("fails closed for an active key with an invalid read-only marker", async () => {
    apiKeyFindFirst.mockResolvedValue({
      ...liveRow,
      readOnlyUntil: new Date("2026-09-24T01:00:01.000Z"),
    });
    const req = post({ authorization: "Bearer odoo_testkey" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
  });

  it("propagates unexpected tenant database errors instead of treating them as bad credentials", async () => {
    const failure = new Error("database temporarily unavailable");
    requireActiveTenantOrNull.mockRejectedValueOnce(failure);
    const req = post({ authorization: "Bearer odoo_testkey" });
    await expect(validateOdooKey(req)).rejects.toBe(failure);
  });

  it("rejects keys without the odoo_ prefix", async () => {
    const req = post({ authorization: "Bearer other_testkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
    expect(apiKeyFindFirst).not.toHaveBeenCalled();
  });

});
