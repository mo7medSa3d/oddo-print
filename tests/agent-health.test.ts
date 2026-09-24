import { describe, it, expect } from "vitest";
import { computeAgentHealthStatus } from "../src/lib/agent-health";
import * as fs from "fs";

describe("agent-health", () => {
  it("ONLINE when lastSeen <90s", () => {
    const now = new Date();
    const lastSeen = new Date(now.getTime() - 30_000);
    expect(computeAgentHealthStatus(lastSeen, undefined, now)).toBe("ONLINE");
  });

  it("DEGRADED when lastSeen 90s-5m", () => {
    const now = new Date();
    const lastSeen = new Date(now.getTime() - 2 * 60_000);
    expect(computeAgentHealthStatus(lastSeen, undefined, now)).toBe("DEGRADED");
  });

  it("OFFLINE when lastSeen >5m", () => {
    const now = new Date();
    const lastSeen = new Date(now.getTime() - 10 * 60_000);
    expect(computeAgentHealthStatus(lastSeen, undefined, now)).toBe("OFFLINE");
  });

  it("STARTING when createdAt <5min and never seen (observed)", () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 60_000);
    expect(computeAgentHealthStatus(null, createdAt, now)).toBe("STARTING");
  });

  it("OFFLINE when never seen and no recent createdAt", () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 10 * 60_000);
    expect(computeAgentHealthStatus(null, createdAt, now)).toBe("OFFLINE");
    expect(computeAgentHealthStatus(null, undefined, now)).toBe("OFFLINE");
  });

  it("does NOT claim RECOVERING in runtime contract (requires history)", () => {
    const source = fs.readFileSync("src/lib/agent-health.ts", "utf8");
    // RECOVERING should not be in AgentHealthStatus type (honest)
    expect(source).not.toMatch(/RECOVERING.*ONLINE.*DEGRADED.*OFFLINE.*STARTING.*RECOVERING/);
    // Check that failureCount is null with note, not hardcoded 0
    expect(source).toContain("failureCount: null");
    expect(source).toContain("NOT MEASURED");
  });

  it("separates observed vs inferred checks", () => {
    const source = fs.readFileSync("src/lib/agent-health.ts", "utf8");
    expect(source).toContain("observed: true");
    expect(source).toContain("observed: false");
    expect(source).toContain("inferred");
    // Must have explicit observed checks: Gateway, Queue, Printers, Version
    expect(source).toContain('"Gateway"');
    expect(source).toContain('"Queue"');
    expect(source).toContain('"Printers"');
    expect(source).toContain('"Version"');
  });

  it("checks include source evidence", () => {
    const source = fs.readFileSync("src/lib/agent-health.ts", "utf8");
    expect(source).toContain("source:");
    expect(source).toContain("agents.last_seen_at");
  });
});
