import { describe, expect, it } from "vitest";
import { buildJobEnvelope, MAX_WS_JOB_ENVELOPE_BYTES } from "../src/server/ws";
import type { ClaimedJobRow } from "../src/lib/job-delivery";

// The agent rejects inbound frames over 8 MiB (maxWSFrameBytes). A 5 MiB
// document base64-encodes to ~6.9 MiB of JSON, so the delivery envelope must
// carry the payload exactly once: the historical duplicated representation
// (job.payload + top-level payload) frames at ~14 MiB and strands jobs the
// gateway recorded as delivered.
const AGENT_FRAME_LIMIT = 8 * 1024 * 1024;

function maxClaimedRow(): ClaimedJobRow {
  const raw = "A".repeat(5 * 1024 * 1024);
  const data = Buffer.from(raw, "utf8").toString("base64");
  return {
    id: "job_budget",
    tenantId: "tenant_budget",
    agentId: "agent_budget",
    printerId: "printer_budget",
    documentType: "document",
    status: "claimed",
    payload: { type: "raw", encoding: "base64", data, protocol: "raw" },
    expiresAt: new Date("2026-10-07T00:00:00.000Z"),
    retries: 0,
    deliveryAttempts: 1,
    claimToken: "claim-budget",
    createdAt: new Date("2026-10-07T00:00:00.000Z"),
    requestId: "req-budget",
  };
}

describe("WS job envelope wire budget", () => {
  it("carries the document payload exactly once", () => {
    const envelope = buildJobEnvelope(maxClaimedRow()) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("payload");
    expect(envelope.job).toMatchObject({ id: "job_budget" });
    expect((envelope.job as Record<string, unknown>).payload).toBeDefined();
  });

  it("frames a maximum-size document below the agent read limit", () => {
    const wireBytes = Buffer.byteLength(JSON.stringify(buildJobEnvelope(maxClaimedRow())), "utf8");
    expect(wireBytes).toBeLessThanOrEqual(MAX_WS_JOB_ENVELOPE_BYTES);
    expect(wireBytes).toBeLessThan(AGENT_FRAME_LIMIT);
  });

  it("would exceed the agent read limit with the duplicated representation", () => {
    const envelope = buildJobEnvelope(maxClaimedRow()) as Record<string, unknown> & {
      job: Record<string, unknown>;
    };
    const duplicated = { ...envelope, payload: envelope.job.payload };
    expect(Buffer.byteLength(JSON.stringify(duplicated), "utf8")).toBeGreaterThan(AGENT_FRAME_LIMIT);
  });

  it("keeps the send budget below the agent frame limit", () => {
    expect(MAX_WS_JOB_ENVELOPE_BYTES).toBeLessThan(AGENT_FRAME_LIMIT);
  });
});
