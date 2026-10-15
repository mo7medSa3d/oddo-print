import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), createJob: vi.fn(), event: vi.fn(), now: vi.fn() }));
vi.mock("../src/db", () => ({ db: { select: mocks.select } }));
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: async () => ({ tenantId: "tenant", userId: "operator", role: "owner" }) }));
vi.mock("../src/lib/authorization", () => ({ requireManagerPermission: () => {} }));
vi.mock("../src/lib/printer-health", () => ({ getPrinterCapabilityMatrix: async () => ({ documentTypes: ["pdf"] }) }));
vi.mock("../src/lib/print-job-service", async (original) => ({
  ...(await original<typeof import("../src/lib/print-job-service")>()), createPrintJobForPrinter: mocks.createJob,
}));
vi.mock("../src/lib/database-clock", async (original) => ({
  ...(await original<typeof import("../src/lib/database-clock")>()), databaseNowMs: mocks.now,
}));
vi.mock("../src/lib/job-timeline", () => ({ recordJobEvent: mocks.event }));

import { POST } from "../src/app/api/printers/[id]/certify/route";

const now = new Date("2026-10-15T12:00:00Z");
const printer = { id: "selected", tenantId: "tenant", agentId: "agent", name: "Installed queue",
  connectionType: "spooler", protocol: "spooler", capabilities: null, config: { spooler_name: "Installed queue" } };

function replyRows(job: Record<string, unknown>) {
  const rows = [[printer], [job], [{ id: "agent", lastSeenAt: now }]];
  mocks.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => rows.shift() ?? [] }) }) }));
}

async function certify(body?: string) {
  return POST(new Request("https://gateway.test/api/printers/selected/certify", {
    method: "POST", headers: { "Idempotency-Key": "same-operation", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  }), { params: Promise.resolve({ id: "selected" }) });
}

describe("certification evidence and request handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.now.mockResolvedValue(now.getTime());
    mocks.createJob.mockResolvedValue({ id: "job", status: "queued", isReused: true });
    mocks.event.mockResolvedValue(undefined);
  });

  it("accepts an empty POST without Content-Length using the same canonical diagnostic pipeline", async () => {
    replyRows({ id: "job", status: "queued" });
    const response = await certify();
    expect(response.status).toBe(200);
    expect(mocks.createJob).toHaveBeenCalledOnce();
    const result = await response.json();
    expect(result).toMatchObject({ jobId: "job", certified: false, blocked: true });
    expect(JSON.stringify(result)).not.toContain("sandbox has no printer");
  });

  it("keeps malformed nonempty JSON from creating any physical intent", async () => {
    replyRows({ id: "job", status: "queued" });
    expect((await certify("{")).status).toBe(400);
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("does not show an Agent claim or transport success for failure before claim", async () => {
    replyRows({ id: "job", status: "failed", error: "Expired without delivery" });
    const response = await certify("{}");
    const result = await response.json();
    const step = (id: string) => result.steps.find((entry: { id: string }) => entry.id === id);
    expect(step("claim").status).toBe("error");
    expect(step("agent").status).not.toBe("ok");
    expect(step("transport").status).not.toBe("ok");
    expect(step("final").status).toBe("error");
    expect(result.certified).toBe(false);
  });

  it("preserves an expired attempt's real claim evidence without treating it as printed", async () => {
    replyRows({ id: "job", status: "expired", claimedAt: now, claimToken: "live-attempt" });
    const result = await (await certify("{}")).json();
    expect(result.steps.find((entry: { id: string }) => entry.id === "claim").status).toBe("ok");
    expect(result.steps.find((entry: { id: string }) => entry.id === "final").status).toBe("error");
    expect(result.certified).toBe(false);
    expect(result.blocked).toBe(true);
  });
});
