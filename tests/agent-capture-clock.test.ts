import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selection: {} as Record<string, unknown>,
  rows: [] as Record<string, unknown>[],
}));

vi.mock("../src/db", () => ({
  db: {
    select: vi.fn((selection: Record<string, unknown>) => {
      state.selection = selection;
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => state.rows,
      };
      return query;
    }),
  },
}));
vi.mock("../src/lib/agent-auth", () => ({
  validateAgent: vi.fn(async () => ({ id: "agt_12345678", tenantId: "tenant-clock" })),
}));
vi.mock("../src/lib/e2e-capture", () => ({ captureEnabled: () => true }));
vi.mock("../src/lib/log", () => ({ logError: vi.fn() }));

import { GET } from "../src/app/api/agent/test-captures/status/route";

describe("paired Agent capture expiry uses PostgreSQL time", () => {
  beforeEach(() => {
    state.rows = [
      { runId: "cap_active", status: "queued", expired: false, errorCode: null },
      { runId: "cap_expired", status: "claimed", expired: true, errorCode: null },
      { runId: "cap_finished", status: "rendered_locally", expired: false, errorCode: null },
    ];
  });
  afterEach(() => vi.useRealTimers());

  for (const hostTime of ["2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"]) {
    it(`preserves database expiry decisions while the host clock is ${hostTime}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(hostTime));
      const response = await GET(new Request("https://gateway.invalid/api/agent/test-captures/status"));
      expect(response.status).toBe(200);
      expect(state.selection.expired).toBeDefined();
      expect(state.selection.expiresAt).toBeUndefined();
      const body = await response.json();
      expect(body.items).toEqual([
        { runId: "cap_active", status: "queued", errorCode: null },
        { runId: "cap_expired", status: "expired", errorCode: "CAPTURE_TIMED_OUT" },
        { runId: "cap_finished", status: "rendered_locally", errorCode: null },
      ]);
      expect(body.physicalPrinted).toBe(false);
      expect(body.simulationOnly).toBe(true);
    });
  }
});
