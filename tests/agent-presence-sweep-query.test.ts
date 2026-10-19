import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const database = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/db", () => ({ db: database }));
vi.mock("../src/lib/agent-availability", () => ({ agentStaleThresholdSeconds: () => 90 }));
import { sweepStaleAgentPresence } from "../src/lib/agent-presence-maintenance";

describe("bounded stale-Agent presence persistence", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    database.execute.mockResolvedValue({ rows: [{ id: "agent-a" }, { id: "agent-b" }] });
  });

  it("locks only ordered stale active candidates, skips other workers' locks, and returns the batch count", async () => {
    expect(await sweepStaleAgentPresence()).toBe(2);
    const query = new PgDialect().sqlToQuery(database.execute.mock.calls[0][0]);
    expect(query.sql).toContain("lifecycle = 'active'");
    expect(query.sql).toContain("status = 'online'");
    expect(query.sql).toContain("last_seen_at IS NULL OR last_seen_at <");
    expect(query.sql).toContain("ORDER BY last_seen_at ASC NULLS FIRST, id ASC");
    expect(query.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.sql).toContain("WHERE agents.id = candidates.id");
    expect(query.params).toEqual([90, 200]);
    expect(query.sql).not.toContain("print_jobs");
  });

  it.each([["0", 200], ["-4", 200], ["NaN", 200], ["Infinity", 200], ["0.5", 1], ["17.9", 17], ["1000000", 5000]])("bounds configured batch %s", async (configured, expected) => {
    vi.stubEnv("AGENT_PRESENCE_SWEEP_LIMIT", configured);
    database.execute.mockResolvedValue({ rows: [] });
    expect(await sweepStaleAgentPresence()).toBe(0);
    const query = new PgDialect().sqlToQuery(database.execute.mock.calls[0][0]);
    expect(query.params).toEqual([90, expected]);
  });

  it("propagates database failure so housekeeping can report it", async () => {
    database.execute.mockRejectedValue(new Error("database unavailable"));
    await expect(sweepStaleAgentPresence()).rejects.toThrow("database unavailable");
  });
});
