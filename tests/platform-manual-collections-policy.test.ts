import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), select: vi.fn(), execute: vi.fn(), transaction: vi.fn(), readGuard: vi.fn() }));
vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mocks.auth,
  requirePlatformActorInTransaction: vi.fn(),
  requirePlatformReadAuthorityInTransaction: mocks.readGuard,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
  PlatformMutationAuthorityChangedError: class PlatformMutationAuthorityChangedError extends Error {},
}));
vi.mock("../src/db", () => ({ db: { select: mocks.select, execute: mocks.execute, transaction: mocks.transaction } }));
import { GET as readPlans } from "../src/app/api/platform/plans/route";
import { GET as readRequests } from "../src/app/api/platform/subscription-requests/route";

describe("Platform Owner manual plan and subscription-request reads", () => {
  beforeEach(() => {
    mocks.auth.mockReset().mockResolvedValue(undefined);
    mocks.select.mockReset().mockReturnValue({ from: () => ({ orderBy: async () => [{ id: "plan-manual" }] }) });
    mocks.execute.mockReset().mockResolvedValue({ rows: [] });
    mocks.readGuard.mockReset().mockResolvedValue(undefined);
    mocks.transaction.mockReset().mockImplementation(async (fn: (tx: { execute: typeof mocks.execute; select: typeof mocks.select }) => unknown) => fn({ execute: mocks.execute, select: mocks.select }));
  });

  it("does not allow authenticated plan catalog metadata to be cached", async () => {
    const response = await readPlans(new Request("http://gateway.test/api/platform/plans"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ plans: [{ id: "plan-manual" }] });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.readGuard).toHaveBeenCalledOnce();
    expect(mocks.readGuard.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]);
  });

  it("rejects stale Platform Owner before plan metadata can be selected", async () => {
    const { PlatformUnauthorizedError } = await import("../src/lib/platform-auth");
    mocks.readGuard.mockRejectedValueOnce(new PlatformUnauthorizedError());
    const response = await readPlans(new Request("http://gateway.test/api/platform/plans"));
    expect(response.status).toBe(401);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it.each(["", " ", " 2", "2 ", "+1", "-1", "2.5", "1e2", "0x20", "5garbage", "1000001", "9007199254740992"])(
    "denies malformed subscription request offset %s before database work", async invalid => {
      const url = new URL("http://gateway.test/api/platform/subscription-requests");
      url.searchParams.set("offset", invalid);
      const response = await readRequests(new Request(url));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_OFFSET" });
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it("admits an exact decimal offset and keeps subscription requests private", async () => {
    const response = await readRequests(new Request("http://gateway.test/api/platform/subscription-requests?offset=0005"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ requests: [], offset: 5, pendingCount: 0 });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.readGuard).toHaveBeenCalledOnce();
    expect(mocks.readGuard.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0]);
  });
  it("rejects a Platform Owner revoked after the initial HTTP authentication, before exposing requests", async () => {
    const { PlatformUnauthorizedError } = await import("../src/lib/platform-auth");
    mocks.readGuard.mockRejectedValueOnce(new PlatformUnauthorizedError());
    const response = await readRequests(new Request("http://gateway.test/api/platform/subscription-requests"));
    expect(response.status).toBe(401);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

});
