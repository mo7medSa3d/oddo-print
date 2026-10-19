import { describe, expect, it, vi } from "vitest";

// Fail if the browser-safe job contract ever loads the server database graph.
vi.mock("../src/db", () => {
  throw new Error("Browser job-status consumers must not load PostgreSQL");
});

import { parseDbTimeMs } from "../src/lib/database-timestamp";
import { derivePhysicalOutcome, isExpiredLateSuccessAllowed, isLateSuccessAllowed } from "../src/lib/job-status";

describe("browser-safe job status and timestamps", () => {
  it("retains unknown physical outcomes without loading server modules", () => {
    expect(derivePhysicalOutcome("success", null)).toBe("unknown");
    expect(derivePhysicalOutcome("failed", "UNKNOWN_PARTIAL_DELIVERY: write failed")).toBe("unknown");
    expect(derivePhysicalOutcome("failed", "connection refused")).toBe("not_printed");
  });

  it("normalizes naive UTC and PostgreSQL offset timestamps consistently", () => {
    const expected = Date.parse("2026-10-04T05:00:00Z");
    expect(parseDbTimeMs("2026-10-04 05:00:00")).toBe(expected);
    expect(parseDbTimeMs("2026-10-04 08:00:00+03")).toBe(expected);
    expect(parseDbTimeMs(new Date(expected))).toBe(expected);
    expect(parseDbTimeMs(null)).toBeNull();
    expect(parseDbTimeMs("invalid")).toBeNull();
  });

  it("keeps the caller-supplied authoritative clock for grace-window decisions", () => {
    const nowMs = Date.parse("2026-10-04T05:01:00Z");
    expect(isExpiredLateSuccessAllowed({ status: "expired", expiresAt: "2026-10-04 05:00:00", updatedAt: "2026-10-04 05:00:00" }, nowMs)).toBe(true);
    expect(isExpiredLateSuccessAllowed({ status: "expired", expiresAt: "2026-10-04 05:00:00", updatedAt: "2026-10-04 05:00:00" }, nowMs + 600000)).toBe(false);
    expect(isLateSuccessAllowed({ status: "failed", error: "AGENT_EXECUTION_TIMEOUT", updatedAt: new Date(nowMs - 1000) }, nowMs)).toBe(true);
  });
});
