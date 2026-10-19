import { describe, it, expect } from "vitest";
import { generateRequestId, generateAttemptId, generateClaimId, withCorrelationHeaders } from "../src/server/correlation";

describe("correlation-ids", () => {
  it("generates requestId with req_ prefix", () => {
    const id = generateRequestId();
    expect(id.startsWith("req_")).toBe(true);
    expect(id.length).toBeGreaterThan(8);
  });

  it("generates attemptId with attempt_ prefix", () => {
    const id = generateAttemptId();
    expect(id.startsWith("attempt_")).toBe(true);
  });

  it("generates claimId with claim_ prefix", () => {
    const id = generateClaimId();
    expect(id.startsWith("claim_")).toBe(true);
  });

  it("withCorrelationHeaders adds all correlation headers", () => {
    const headers = withCorrelationHeaders({}, {
      requestId: "req_123",
      jobId: "job_abc",
      tenantId: "tenant_xyz",
      agentId: "agent_1",
      printerId: "printer_1",
      attemptId: "attempt_1",
      claimId: "claim_1",
      spoolerJobId: "42",
    });
    expect(headers["x-request-id"]).toBe("req_123");
    expect(headers["x-job-id"]).toBe("job_abc");
    expect(headers["x-tenant-id"]).toBe("tenant_xyz");
    expect(headers["x-agent-id"]).toBe("agent_1");
    expect(headers["x-printer-id"]).toBe("printer_1");
    expect(headers["x-attempt-id"]).toBe("attempt_1");
    expect(headers["x-claim-id"]).toBe("claim_1");
    expect(headers["x-spooler-job-id"]).toBe("42");
  });

  it("correlation IDs respect length limits", () => {
    const longId = "a".repeat(200);
    // requestIdFrom should mint new if too long (tested in log.ts)
    // Here we just check generation stays reasonable
    const id = generateRequestId();
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
