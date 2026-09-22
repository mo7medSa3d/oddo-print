import { describe, expect, it } from "vitest";
import { normalizePlanEntitlements } from "../src/lib/entitlements";

describe("plan entitlements", () => {
  it("accepts the canonical numeric entitlement contract", () => {
    expect(normalizePlanEntitlements({
      max_agents: 3,
      max_printers: 20,
      max_jobs_per_minute: 300,
      max_concurrent_jobs: 32,
      max_prints_per_period: 20,
    })).toEqual({
      max_agents: 3,
      max_printers: 20,
      max_jobs_per_minute: 300,
      max_concurrent_jobs: 32,
      max_prints_per_period: 20,
    });
  });

  it("accepts unlimited values", () => {
    const result = normalizePlanEntitlements({
      max_agents: "unlimited",
      max_printers: 50,
      max_jobs_per_minute: 1000,
      max_concurrent_jobs: "unlimited",
      max_prints_per_period: "unlimited",
    });
    expect(result.max_agents).toBe("unlimited");
    expect(result.max_concurrent_jobs).toBe("unlimited");
    expect(result.max_prints_per_period).toBe("unlimited");
  });

  it("rejects missing canonical limits", () => {
    expect(() => normalizePlanEntitlements({
      max_agents: 1,
      max_printers: 1,
      max_jobs_per_minute: 60,
      max_concurrent_jobs: 8,
    })).toThrow();
  });

  it("rejects zero, negative, fractional and non-numeric limits", () => {
    for (const value of [0, -1, 1.5, "60"]) {
      expect(() => normalizePlanEntitlements({
        max_agents: value,
        max_printers: 1,
        max_jobs_per_minute: 60,
        max_concurrent_jobs: 8,
      })).toThrow();
    }
  });
});
