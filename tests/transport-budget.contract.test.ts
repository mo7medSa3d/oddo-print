import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function literalInt(source: string, pattern: RegExp, what: string): number {
  const match = source.match(pattern);
  expect(match, `${what} literal not found`).not.toBeNull();
  // eslint-disable-next-line no-eval
  return eval(match![1]) as number;
}

// Transport budgets are measured on encoded wire bytes on every side.
// These pins stop the next budget-drift bug (count-only batch limits vs
// base64-inflated frames): if anyone changes a batch size, payload ceiling,
// or frame limit on one side without the other, these fail before CI does.
describe("agent/gateway transport budget parity", () => {
  it("poll batch count matches on both sides", () => {
    const route = read("src/app/api/agent/jobs/route.ts");
    const agent = read("agent/internal/agent/agent.go");
    expect(literalInt(route, /const MAX_CLAIM_BATCH = (\d+);/, "gateway MAX_CLAIM_BATCH")).toBe(20);
    expect(literalInt(agent, /maxClaimBatch\s*=\s*(\d+)/, "agent maxClaimBatch")).toBe(20);
  });

  it("gateway poll response budget stays below the agent poll reader", () => {
    const route = read("src/app/api/agent/jobs/route.ts");
    const agentPayload = read("agent/internal/payload/payload.go");
    const budget = literalInt(route, /const MAX_POLL_RESPONSE_BYTES = ([0-9* ]+);/, "MAX_POLL_RESPONSE_BYTES");
    const maxPayload = literalInt(agentPayload, /MaxPayloadBytes = ([0-9* ]+)/, "MaxPayloadBytes");
    const agentReader = 20 * maxPayload;
    expect(budget).toBeLessThan(agentReader);
    // A single maximum document (~6.9 MiB encoded) must always fit.
    expect(budget).toBeGreaterThan(Math.ceil((maxPayload / 3)) * 4 + 1024 * 1024);
  });

  it("WS envelope budget stays below the agent frame limit", () => {
    const ws = read("src/server/ws.ts");
    const agent = read("agent/internal/agent/agent.go");
    expect(ws).toContain("MAX_WS_JOB_ENVELOPE_BYTES = (8 << 20) - (512 << 10)");
    const frame = literalInt(agent, /maxWSFrameBytes = (\d+ << \d+)/, "maxWSFrameBytes");
    expect((8 << 20) - (512 << 10)).toBeLessThan(frame);
  });
});
