import { beforeEach, describe, expect, it, vi } from "vitest";
const fns = vi.hoisted(() => ({ auth: vi.fn(), guard: vi.fn(), transaction: vi.fn(), read: vi.fn() }));
vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: fns.auth,
  requirePlatformReadAuthorityInTransaction: fns.guard,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
}));
vi.mock("../src/lib/platform-data-explorer", () => ({ readPlatformDatabase: fns.read }));
vi.mock("../src/db", () => ({ db: { transaction: fns.transaction } }));
import { GET } from "../src/app/api/platform/database/route";
import { PlatformUnauthorizedError } from "../src/lib/platform-auth";
const req = (q = "") => new Request("https://example.test/api/platform/database" + q);
const empty = { tables: [], selected: null, columns: [], rows: [], hasMore: false };

describe("Platform Owner database explorer authentication and query API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fns.auth.mockResolvedValue({ userId: "owner" });
    fns.guard.mockResolvedValue(undefined);
    fns.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => fn({}));
    fns.read.mockResolvedValue(empty);
  });
  it("returns 401 for invalid credentials without querying", async () => {
    fns.auth.mockRejectedValueOnce(new PlatformUnauthorizedError("expired"));
    const result = await GET(req());
    expect(result.status).toBe(401);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(fns.read).not.toHaveBeenCalled();
  });
  it("returns 503 for unavailable owner-auth dependency, not 401", async () => {
    fns.auth.mockRejectedValueOnce(new Error("database unavailable"));
    const result = await GET(req());
    expect(result.status).toBe(503);
    expect((await result.json()).error).toBe("Platform authentication temporarily unavailable");
    expect(fns.read).not.toHaveBeenCalled();
  });
  it("rejects unsafe table names before any metadata lookup", async () => {
    const result = await GET(req("?table=printers%3BDROP%20TABLE"));
    expect(result.status).toBe(400);
    expect(fns.read).not.toHaveBeenCalled();
  });
  it("binds validated search and offset to the service", async () => {
    fns.read.mockResolvedValueOnce({ ...empty, selected: "printers", columns: ["id"], rows: [{ id: "A1" }] });
    const result = await GET(req("?table=printers&q=printer&offset=25"));
    expect(result.status).toBe(200);
    expect(fns.read).toHaveBeenCalledWith(expect.anything(), { table: "printers", search: "printer", offset: 25 });
    expect(fns.guard).toHaveBeenCalledOnce();
    expect(fns.guard.mock.invocationCallOrder[0]).toBeLessThan(fns.read.mock.invocationCallOrder[0]);
  });
  it("denies a revoked owner in the live transaction before opening the catalog", async () => {
    fns.guard.mockRejectedValueOnce(new PlatformUnauthorizedError("revoked"));
    const result = await GET(req("?table=printers"));
    expect(result.status).toBe(401);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fns.read).not.toHaveBeenCalled();
  });
  it("does not expose tables hidden by metadata policy", async () => {
    const result = await GET(req("?table=refresh_tokens"));
    expect(result.status).toBe(404);
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
});
