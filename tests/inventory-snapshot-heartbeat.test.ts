import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), update: vi.fn(), transaction: vi.fn(), activeTenant: vi.fn(),
}));
vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/lib/agent-auth", () => ({ validateAgent: vi.fn(async () => ({ id: "agent-a", tenantId: "tenant-a", lifecycle: "active" })) }));
vi.mock("../src/lib/tenant-guard", () => ({ requireActiveTenantInTransaction: mocks.activeTenant }));
import { POST } from "../src/app/api/agent/heartbeat/route";

describe("heartbeat rejects stale writers before inventory mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback({ execute: mocks.execute, update: mocks.update }));
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      id: "agent-a", lifecycle: "active", inventory_snapshot_version: "1791392400000000002",
      inventory_snapshot_id: null, inventory_snapshot_next_page: 1,
    }] });
  });

  it.each(["1791392400000000001", "1791392400000000002", undefined])("rejects old/replayed/downgraded page 1 version %s", async (version) => {
    const response = await POST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ inventorySnapshotId: "old-empty", inventorySnapshotVersion: version, inventoryComplete: true, printers: [] }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INVENTORY_SNAPSHOT_CONFLICT", minimumSnapshotVersion: "1791392400000000002" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.activeTenant).not.toHaveBeenCalled();
    const lockedSql = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]).sql;
    expect(lockedSql).toContain("inventory_snapshot_version");
    expect(lockedSql).toContain("FOR UPDATE");
  });
});
