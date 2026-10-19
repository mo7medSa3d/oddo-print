import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/lib/agent-auth", () => ({ validateAgent: vi.fn(async () => ({ id: "agent", tenantId: "tenant", lifecycle: "active" })) }));
import { POST } from "../src/app/api/agent/heartbeat/route";
import { isPrinterAvailableForJob, isPrinterStatusExecutable } from "../src/lib/routing";

describe("sharing controls require ordered snapshot identity before mutation", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([
    { privatePrinterIds: [] },
    { privatePrinterIds: ["private"] },
    { printers: [{ sharedWithGateway: true }] },
    { privatePrinterIds: [], inventorySnapshotId: "only-id", inventorySnapshotVersion: "1" },
    { privatePrinterIds: [], heartbeatPage: 1, heartbeatPageCount: 1, inventorySnapshotId: "missing-version" },
  ])("rejects incomplete control tuple %s", async (body) => {
    const response = await POST(new Request("https://gateway.test/api/agent/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("separates physical readiness from permission to receive cloud work", () => {
    const printer = { lifecycle: "active", status: "online", connectionType: "spooler", protocol: "spooler" };
    expect(isPrinterStatusExecutable(printer)).toBe(true);
    expect(isPrinterAvailableForJob({ ...printer, sharedWithGateway: false })).toBe(false);
    expect(isPrinterAvailableForJob({ ...printer, sharedWithGateway: true })).toBe(true);
    expect(isPrinterAvailableForJob(printer)).toBe(true);
  });
});
