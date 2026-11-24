import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  authenticate: vi.fn(),
  guard: vi.fn(),
  transaction: vi.fn(),
  select: vi.fn(),
  bounded: vi.fn(),
}));

vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mock.authenticate,
  requirePlatformReadAuthorityInTransaction: mock.guard,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
}));
vi.mock("../src/db", () => ({ db: { transaction: mock.transaction } }));
vi.mock("../src/db/client", () => ({ queryWithTimeout: mock.bounded }));

import { GET } from "../src/app/api/platform/audit/route";
import { PlatformUnauthorizedError } from "../src/lib/platform-auth";

describe("private Platform audit history", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.authenticate.mockResolvedValue({ userId: "owner", sid: "session" });
    mock.guard.mockResolvedValue(undefined);
    mock.bounded.mockImplementation(async (fn: () => unknown) => fn());
    mock.select.mockReturnValue({ from: () => ({
      leftJoin: () => ({ orderBy: () => ({ limit: async () => [{ id: "audit-a" }] }) }),
    }) });
    mock.transaction.mockImplementation(async (fn: (tx: { select: typeof mock.select }) => unknown) => fn({ select: mock.select }));
  });

  it("holds live owner authority through audit SQL and marks the payload private", async () => {
    const response = await GET(new Request("http://gateway.test/api/platform/audit?limit=10"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ auditEvents: [{ id: "audit-a" }] });
    expect(mock.transaction).toHaveBeenCalledOnce();
    expect(mock.guard).toHaveBeenCalledOnce();
    expect(mock.guard.mock.invocationCallOrder[0]).toBeLessThan(mock.select.mock.invocationCallOrder[0]);
  });

  it("rejects a revoked Platform Owner after preflight before accessing audit metadata", async () => {
    mock.guard.mockRejectedValueOnce(new PlatformUnauthorizedError());
    const response = await GET(new Request("http://gateway.test/api/platform/audit"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mock.select).not.toHaveBeenCalled();
  });

  it("rejects malformed limits without querying the audit ledger", async () => {
    const response = await GET(new Request("http://gateway.test/api/platform/audit?limit=1e2"));
    expect(response.status).toBe(400);
    expect(mock.select).not.toHaveBeenCalled();
  });
});
