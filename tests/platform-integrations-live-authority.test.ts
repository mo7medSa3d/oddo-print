import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  guard: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  timeout: vi.fn(),
}));

vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mocks.auth,
  requirePlatformReadAuthorityInTransaction: mocks.guard,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
}));
vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/db/client", () => ({ queryWithTimeout: mocks.timeout }));

import { PlatformUnauthorizedError } from "../src/lib/platform-auth";
import { GET } from "../src/app/api/platform/integrations/route";

describe("Platform integration inventory live owner fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ userId: "owner" });
    mocks.guard.mockResolvedValue(undefined);
    mocks.timeout.mockImplementation(async (fn: () => unknown) => fn());
    mocks.select.mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => ({ offset: async () => [{ id: "integrator-a" }] }) }),
          }),
        }),
      }),
    });
    mocks.transaction.mockImplementation(async (fn: (tx: { select: typeof mocks.select }) => unknown) => fn({ select: mocks.select }));
  });

  it.each(["keys", "installations"] as const)(
    "holds live session through private %s SQL, without revealing credentials", async kind => {
      const response = await GET(new Request("http://gateway.test/api/platform/integrations?kind=" + kind));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ kind, items: [{ id: "integrator-a" }] });
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.guard).toHaveBeenCalledOnce();
      expect(mocks.guard.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]);
    },
  );

  it.each(["keys", "installations"] as const)(
    "denies %s after session revocation between preflight and SQL", async kind => {
      mocks.guard.mockRejectedValueOnce(new PlatformUnauthorizedError());
      const response = await GET(new Request("http://gateway.test/api/platform/integrations?kind=" + kind));
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );
});
