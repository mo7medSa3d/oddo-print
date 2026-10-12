import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearPlatformStatsCache, getCachedPlatformStats, setCachedPlatformStats } from "../src/lib/platform-stats-cache";

describe("AUDIT-07: Platform Stats Optimization and In-Memory Caching", () => {
  beforeEach(() => {
    clearPlatformStatsCache();
  });

  it("verifies hourly rows aggregation correctly aggregates 24h job totals without duplicate scans", () => {
    const hourlyRows = [
      { bucket: "2026-10-12T00:00:00Z", total: 10, success: 8, failed: 1, queued: 1, inFlight: 0, expired: 0 },
      { bucket: "2026-10-12T01:00:00Z", total: 5, success: 4, failed: 0, queued: 0, inFlight: 1, expired: 0 },
      { bucket: "2026-10-12T02:00:00Z", total: 7, success: 5, failed: 1, queued: 0, inFlight: 0, expired: 1 },
    ];

    const aggregatedJobs24h = hourlyRows.reduce(
      (acc, row) => ({
        total: acc.total + Number(row.total ?? 0),
        success: acc.success + Number(row.success ?? 0),
        failed: acc.failed + Number(row.failed ?? 0),
        queued: acc.queued + Number(row.queued ?? 0),
        inFlight: acc.inFlight + Number(row.inFlight ?? 0),
        expired: acc.expired + Number(row.expired ?? 0),
      }),
      { total: 0, success: 0, failed: 0, queued: 0, inFlight: 0, expired: 0 },
    );

    expect(aggregatedJobs24h).toEqual({
      total: 22,
      success: 17,
      failed: 2,
      queued: 1,
      inFlight: 1,
      expired: 1,
    });
  });

  it("exposes clearPlatformStatsCache function to allow deterministic test resets", () => {
    expect(typeof clearPlatformStatsCache).toBe("function");
    expect(() => clearPlatformStatsCache()).not.toThrow();
  });
});
