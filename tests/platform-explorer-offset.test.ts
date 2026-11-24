import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), explore: vi.fn(), authority: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mocks.owner,
  requirePlatformReadAuthorityInTransaction: mocks.authority,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
}));
vi.mock("../src/lib/platform-data-explorer", () => ({ readPlatformDatabase: mocks.explore }));
vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
import { GET } from "../src/app/api/platform/database/route";

describe("platform database explorer offset contract", () => {
  beforeEach(() => {
    mocks.owner.mockReset().mockResolvedValue({ id: "owner" });
    mocks.authority.mockReset().mockResolvedValue(undefined);
    mocks.transaction.mockReset().mockImplementation(async (callback: (tx: object) => Promise<unknown>) => callback({}));
    mocks.explore.mockReset().mockResolvedValue({ selected: "tenants", rows: [], tables: [] });
  });

  it.each(["", " ", " 4", "+1", "-1", "1e2", "2.5", "0x10", "5garbage", "10001", "9007199254740992"])(
    "rejects malformed %s before database access", async (offset) => {
      const url = new URL("https://gateway.example/api/platform/database?table=tenants");
      url.searchParams.set("offset", offset);
      const response = await GET(new Request(url));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.explore).not.toHaveBeenCalled();
    },
  );

  it("allows canonical zero and padded decimal offsets without widening access", async () => {
    const ok = await GET(new Request("https://gateway.example/api/platform/database?table=tenants&offset=0003"));
    expect(ok.status).toBe(200);
    expect(mocks.explore).toHaveBeenCalledWith(expect.anything(), { table: "tenants", search: undefined, offset: 3 });
    expect(mocks.owner).toHaveBeenCalledTimes(1);
    expect(mocks.authority).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});
