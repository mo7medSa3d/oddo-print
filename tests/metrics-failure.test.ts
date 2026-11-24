import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  owner: vi.fn(),
}));

vi.mock("../src/db", () => ({ pool: { query: state.query }, db: { execute: state.execute } }));
vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: state.owner,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
}));
// Fleet gauges were retired with printing, and the renderer now swallows a
// failed gateway_metrics read. Surface that failure so the route's degraded
// scrape branch (503, no-store, no SQL detail leak) is still exercised.
vi.mock("../src/lib/log", () => ({
  logWarn: (event: string, fields?: { error?: unknown }) => {
    if (event === "metrics.counters_unavailable") throw fields?.error;
  },
}));

import { GET } from "../src/app/api/metrics/route";

describe("metrics collection failures", () => {
  beforeEach(() => {
    state.query.mockReset();
    state.execute.mockReset();
    state.execute.mockResolvedValue({ rows: [] });
    state.owner.mockReset();
    state.owner.mockResolvedValue(undefined);
  });

  it("returns a degraded scrape status, not HTTP 200 with missing fleet gauges", async () => {
    state.query.mockImplementation(async (query: string) => {
      // Fleet gauges were replaced by the gateway_metrics scrape.
      if (query.includes("FROM gateway_metrics")) throw new Error("sensitive database failure details");
      return { rows: [] };
    });

    const response = await GET(new Request("http://localhost/api/metrics"));
    expect(state.query).toHaveBeenCalledWith(expect.stringContaining("FROM gateway_metrics"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("sensitive database failure details");
  });
});
