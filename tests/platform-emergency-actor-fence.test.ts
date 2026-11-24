import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  actorGuard: vi.fn(),
  transaction: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mocks.preflight,
  requirePlatformActorInTransaction: mocks.actorGuard,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
  PlatformMutationAuthorityChangedError: class PlatformMutationAuthorityChangedError extends Error {},
}));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: vi.fn() }));

import { PlatformMutationAuthorityChangedError } from "../src/lib/platform-auth";
import { POST as revokeKey } from "../src/app/api/platform/integrations/revoke/route";
import { POST as quarantineInstallation } from "../src/app/api/platform/integrations/quarantine/route";

type EmergencyOperation = (request: Request) => Promise<Response>;
const cases: Array<{ name: string; handle: EmergencyOperation; path: string }> = [
  { name: "integration revocation", handle: revokeKey, path: "revoke" },
  { name: "installation quarantine", handle: quarantineInstallation, path: "quarantine" },
];

const request = (path: string) => new Request("https://gateway.test/api/platform/integrations/" + path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tenantId: "tenant-a", id: "target-a", confirmed: true }),
});

describe("Platform emergency actions revalidate session before exposing resource state", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.preflight.mockResolvedValue({ userId: "owner", email: "owner@example.test" });
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ select: mocks.select }));
  });

  for (const { name, handle, path } of cases) {
    it(name + " denies a revoked owner before exposing a missing resource", async () => {
      mocks.select.mockImplementation(() => ({
        from: () => ({ where: () => ({ for: async () => [] }) }),
      }));
      mocks.actorGuard.mockRejectedValue(new PlatformMutationAuthorityChangedError());

      const result = await handle(request(path));
      expect(result.status).toBe(403);
      expect(result.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.actorGuard).toHaveBeenCalledOnce();
    });

    it(name + " denies a revoked owner before exposing the inactive state", async () => {
      const inactive = path === "revoke"
        ? { id: "target-a", revokedAt: new Date("2026-10-28T00:00:00Z"), readOnlyUntil: null }
        : { id: "target-a", enabled: false };
      mocks.select.mockImplementation(() => ({
        from: () => ({ where: () => ({ for: async () => [inactive] }) }),
      }));
      mocks.actorGuard.mockRejectedValue(new PlatformMutationAuthorityChangedError());

      const result = await handle(request(path));
      expect(result.status).toBe(403);
      expect(mocks.actorGuard).toHaveBeenCalledOnce();
    });
  }
});
