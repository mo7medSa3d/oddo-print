import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ page: vi.fn(), single: vi.fn(), auth: vi.fn(), permission: vi.fn() }));
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: mocks.auth }));
vi.mock("../src/lib/authorization", () => ({ requireManagerPermission: mocks.permission }));
vi.mock("../src/lib/printer-health", () => ({ getPrinterCapabilityPage: mocks.page, getPrinterCapabilityMatrix: mocks.single }));
import { GET } from "../src/app/api/printers/capabilities/route";

describe("capability collection keyset contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenantId: "tenant-a", role: "admin" });
    mocks.permission.mockImplementation(() => {});
    mocks.page.mockResolvedValue({ items: [{ printerId: "printer-a" }], hasMore: true, nextCursor: "cHJpbnRlci1h" });
  });

  it("preserves the array response and publishes a safe no-store traversal cursor", async () => {
    const response = await GET(new Request("http://gateway.test/api/printers/capabilities?limit=2&after=cHJpbnRlci0w"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ printerId: "printer-a" }]);
    expect(mocks.page).toHaveBeenCalledWith("tenant-a", { limit: 2, afterId: "printer-0" });
    expect(response.headers.get("X-Has-More")).toBe("true");
    expect(response.headers.get("X-Next-Cursor")).toBe("cHJpbnRlci1h");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["!", "", "a", "_w", "YQ==", "a".repeat(641)])("rejects invalid cursor %s before querying", async (cursor) => {
    const response = await GET(new Request(`http://gateway.test/api/printers/capabilities?after=${encodeURIComponent(cursor)}`));
    expect(response.status).toBe(400);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("keeps direct printer lookup tenant-scoped", async () => {
    mocks.single.mockResolvedValue({ printerId: "printer-a" });
    const response = await GET(new Request("http://gateway.test/api/printers/capabilities?printerId=printer-a"));
    expect(await response.json()).toEqual({ printerId: "printer-a" });
    expect(mocks.single).toHaveBeenCalledWith("tenant-a", "printer-a");
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("denies a foreign unauthenticated caller before any capability read", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(new Request("http://gateway.test/api/printers/capabilities"))).status).toBe(401);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("preserves RBAC refusal", async () => {
    mocks.permission.mockImplementation(() => { throw new Error("Forbidden"); });
    expect((await GET(new Request("http://gateway.test/api/printers/capabilities"))).status).toBe(403);
    expect(mocks.page).not.toHaveBeenCalled();
  });
});
