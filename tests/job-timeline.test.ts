import { describe, it, expect } from "vitest";
import { buildTimelineFromJobRow } from "../src/lib/job-timeline";

// The timeline builder takes the full `print_jobs` row type. Fixtures are
// built through this helper so every required column is present and typed;
// partial object literals no longer typecheck.
type PrintJobRow = Parameters<typeof buildTimelineFromJobRow>[0];

function makeJob(overrides: Partial<PrintJobRow> = {}): PrintJobRow {
  const base = new Date("2024-01-01T00:00:00Z");
  return {
    id: "job_123",
    tenantId: "tenant_1",
    apiKeyId: null,
    destination: null,
    documentType: null,
    agentId: "agent_1",
    printerId: "printer_1",
    status: "queued",
    payload: { protocol: "raw", encoding: "base64", data: "aA==" },
    error: null,
    requestedBy: null,
    requestId: null,
    idempotencyKey: null,
    retries: 0,
    claimedAt: null,
    claimToken: null,
    deliveryAttempts: 0,
    deliveredAt: null,
    ackedAt: null,
    expiresAt: new Date("2024-01-01T01:00:00Z"),
    createdAt: base,
    updatedAt: base,
    spoolerJobId: null,
    attemptId: null,
    ...overrides,
  };
}

describe("job-timeline", () => {
  it("builds timeline from job row with all stages", () => {
    const job = makeJob({
      status: "success",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      claimedAt: new Date("2024-01-01T00:01:00Z"),
      deliveredAt: new Date("2024-01-01T00:02:00Z"),
      ackedAt: new Date("2024-01-01T00:03:00Z"),
      updatedAt: new Date("2024-01-01T00:03:00Z"),
      attemptId: "attempt_1",
      spoolerJobId: "42",
      claimToken: "claim_abc",
      requestId: "req_123",
      deliveryAttempts: 1,
    });
    const timeline = buildTimelineFromJobRow(job);
    expect(timeline.length).toBeGreaterThan(0);
    const stages = timeline.map(t => t.stage);
    expect(stages).toContain("created");
    expect(stages).toContain("queued");
    expect(stages).toContain("claimed");
    expect(stages).toContain("success");
    const successStage = timeline.find(t => t.stage === "success");
    expect(successStage?.message).toContain("physical paper output is not independently verified");
  });

  it("includes spoolerJobId linking in timeline when present", () => {
    const job = makeJob({
      status: "printing",
      claimedAt: new Date(),
      deliveredAt: new Date(),
      spoolerJobId: "99",
      attemptId: "attempt_2",
      claimToken: "claim_xyz",
      requestId: "req_456",
      deliveryAttempts: 1,
    });
    const timeline = buildTimelineFromJobRow(job);
    const connectionStage = timeline.find(t => t.stage === "connection");
    expect(connectionStage).toBeDefined();
    expect(connectionStage?.message).toContain("99");
  });

  it("preserves null timestamps when a job has no execution timestamp", () => {
    const printing = buildTimelineFromJobRow(makeJob({ status: "printing" }));
    const accepted = printing.find((entry) => entry.stage === "accepted");
    const printingStage = printing.find((entry) => entry.stage === "printing");
    expect(accepted).toBeDefined();
    expect(printingStage).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(accepted!, "at")).toBe(true);
    expect(accepted!.at).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(printingStage!, "at")).toBe(true);
    expect(printingStage!.at).toBeNull();

    const success = buildTimelineFromJobRow(makeJob({ status: "success" }));
    const delivery = success.find((entry) => entry.stage === "delivery");
    const final = success.find((entry) => entry.stage === "success");
    expect(delivery).toBeDefined();
    expect(final).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(delivery!, "at")).toBe(true);
    expect(delivery!.at).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(final!, "at")).toBe(true);
    expect(final!.at).toBeNull();
  });

  it("handles failed job", () => {
    const job = makeJob({
      status: "failed",
      error: "Printer offline",
      deliveryAttempts: 1,
    });
    const timeline = buildTimelineFromJobRow(job);
    expect(timeline.some(t => t.stage === "failed" && t.status === "error")).toBe(true);
  });

  it("handles expired job", () => {
    const job = makeJob({
      status: "expired",
      deliveryAttempts: 1,
    });
    const timeline = buildTimelineFromJobRow(job);
    expect(timeline.some(t => t.stage === "expired")).toBe(true);
  });
});
