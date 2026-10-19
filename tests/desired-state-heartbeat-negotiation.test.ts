import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), update: vi.fn(), desiredPage: vi.fn() }));
vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/lib/agent-auth", () => ({ validateAgent: async () => ({ id: "agent-a", tenantId: "tenant-a", lifecycle: "active" }) }));
vi.mock("../src/lib/tenant-guard", () => ({ requireActiveTenantInTransaction: async () => {} }));
vi.mock("../src/lib/desired-state-page", () => ({ getDesiredPrinterPage: mocks.desiredPage }));
import { POST } from "../src/app/api/agent/heartbeat/route";

describe("heartbeat desired-state paging negotiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const update = { set: vi.fn(), where: vi.fn() };
    update.set.mockReturnValue(update);
    update.where.mockResolvedValue([]);
    mocks.update.mockReturnValue(update);
    mocks.transaction.mockImplementation(async callback => callback({ execute: mocks.execute, update: mocks.update }));
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "agent-a", lifecycle: "active", inventory_snapshot_version: "0" }] });
    mocks.desiredPage.mockResolvedValue({ items: [], nextCursor: null });
  });

  function heartbeat(desiredStatePaging?: unknown) {
    return POST(new Request("http://gateway.test/api/agent/heartbeat", { method: "POST", body: JSON.stringify({ printers: [], desiredStatePaging }) }));
  }

  it("never supplies a truncated authoritative array to an older Agent", async () => {
    mocks.desiredPage.mockResolvedValue({ items: [{ id: "first" }], nextCursor: "Zmlyc3Q" });
    const response = await heartbeat();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.desiredStateUpgradeRequired).toBe(true);
    expect(body).not.toHaveProperty("desiredState");
  });

  it("preserves the complete small-snapshot legacy response", async () => {
    const response = await heartbeat();
    expect(await response.json()).toMatchObject({ success: true, desiredState: [] });
  });

  it("publishes continuation only when the Agent opts into paging", async () => {
    mocks.desiredPage.mockResolvedValue({ items: [{ id: "first", config: {}, desiredRevision: 1 }], nextCursor: "Zmlyc3Q" });
    const response = await heartbeat(true);
    expect(await response.json()).toMatchObject({ success: true, desiredState: [{ id: "first" }], desiredStateNextCursor: "Zmlyc3Q" });
    expect(mocks.desiredPage).toHaveBeenCalledWith("tenant-a", "agent-a", undefined, expect.any(Function));
  });

  it("rejects an invalid negotiation flag before transaction writes", async () => {
    expect((await heartbeat("true")).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
