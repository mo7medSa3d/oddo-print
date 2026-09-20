import { describe, it, expect } from "vitest";
import { buildTimelineFromJobRow } from "../src/lib/job-timeline";

describe("job-timeline", () => {
  it("builds timeline from job row with all stages", () => {
    const job = {
      id: "job_123",
      agentId: "agent_1",
      printerId: "printer_1",
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
      error: null,
    };
    const timeline = buildTimelineFromJobRow(job);
    expect(timeline.length).toBeGreaterThan(0);
    const stages = timeline.map(t => t.stage);
    expect(stages).toContain("created");
    expect(stages).toContain("queued");
    expect(stages).toContain("claimed");
    expect(stages).toContain("success");
  });

  it("includes spoolerJobId linking in timeline when present", () => {
    const job = {
      id: "job_123",
      agentId: "agent_1",
      printerId: "printer_1",
      status: "printing",
      createdAt: new Date(),
      claimedAt: new Date(),
      deliveredAt: new Date(),
      updatedAt: new Date(),
      spoolerJobId: "99",
      attemptId: "attempt_2",
      claimToken: "claim_xyz",
      requestId: "req_456",
      deliveryAttempts: 1,
      error: null,
    };
    const timeline = buildTimelineFromJobRow(job);
    const connectionStage = timeline.find(t => t.stage === "connection");
    expect(connectionStage).toBeDefined();
    expect(connectionStage?.message).toContain("99");
  });

  it("handles failed job", () => {
    const job = {
      id: "job_123",
      agentId: "agent_1",
      printerId: "printer_1",
      status: "failed",
      createdAt: new Date(),
      updatedAt: new Date(),
      error: "Printer offline",
      deliveryAttempts: 1,
    };
    const timeline = buildTimelineFromJobRow(job);
    expect(timeline.some(t => t.stage === "failed" && t.status === "error")).toBe(true);
  });

  it("handles expired job", () => {
    const job = {
      id: "job_123",
      agentId: "agent_1",
      printerId: "printer_1",
      status: "expired",
      createdAt: new Date(),
      updatedAt: new Date(),
      deliveryAttempts: 1,
    };
    const timeline = buildTimelineFromJobRow(job);
    expect(timeline.some(t => t.stage === "expired")).toBe(true);
  });
});
