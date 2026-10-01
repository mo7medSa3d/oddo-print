import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, pool, closePool } from "./helpers/pg";
import { getAgentHealth } from "../src/lib/agent-health";

/**
 * Database-backed coverage for the two lines changed when the `as any` casts
 * were removed from src/lib/agent-health.ts:
 *   - `const agent = agentRows[0]`     (was `agentRows[0] as any`)
 *   - `const meta = agent.metadata`    (was `agent.metadata as any`)
 * plus the widened `lastOk?: Date | null` declaration.
 *
 * No test previously called getAgentHealth/getAllAgentsHealth at all, so a
 * regression in the metadata/version check or in the never-seen representation
 * would not have been caught.
 */
const suite = describe.skipIf(!hasTestDatabase);

suite("agent health (database-backed)", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); });

  it("reports the Version check from agents.metadata.version", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE agents SET metadata = $2::jsonb WHERE id = $1`,
      [f.agentId, JSON.stringify({ version: "1.26.0", os: "windows", hostname: "pos-1" })]
    );
    const health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health).not.toBeNull();
    const version = health!.checks.find((c) => c.name === "Version");
    expect(version).toBeDefined();
    expect(version!.status).toBe("ok");
    expect(version!.message).toContain("v1.26.0");
    expect(version!.details).toMatchObject({ version: "1.26.0", os: "windows", hostname: "pos-1" });
  });

  it("leaves the Version check unknown when metadata has no version", async () => {
    const f = await seedFixture();
    await pool().query(`UPDATE agents SET metadata = '{}'::jsonb WHERE id = $1`, [f.agentId]);
    const health = await getAgentHealth(f.tenantId, f.agentId);
    const version = health!.checks.find((c) => c.name === "Version");
    expect(version!.status).toBe("unknown");
    expect(version!.message).toContain("Version unknown");
  });

  it("exposes a never-seen agent as null last_ok rather than inventing a timestamp", async () => {
    const f = await seedFixture();
    // A freshly seeded agent has last_seen_at set by the fixture; clear it to
    // represent an agent that has never sent a heartbeat.
    await pool().query(`UPDATE agents SET last_seen_at = NULL WHERE id = $1`, [f.agentId]);
    const health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health).not.toBeNull();

    const gateway = health!.checks.find((c) => c.name === "Gateway");
    expect(gateway).toBeDefined();
    expect(gateway!.message).toContain("Never seen");
    // The observed Gateway check omits lastOk entirely when there is no signal.
    expect(gateway!.lastOk).toBeUndefined();

    // The inferred heartbeat check passes agents.last_seen_at through verbatim,
    // so a never-seen agent yields `null` here. This is the line that failed to
    // compile once the `as any` cast was removed, and it is why lastOk is
    // declared `Date | null` rather than `Date | undefined`: the value is
    // serialized into the API response, so it must not be silently rewritten.
    const inferred = health!.checks.find((c) => c.name.startsWith("Heartbeat (inferred"));
    expect(inferred).toBeDefined();
    expect(inferred!.lastOk).toBeNull();
  });

  it("returns null for an unknown agent id", async () => {
    const f = await seedFixture();
    expect(await getAgentHealth(f.tenantId, "agt_does_not_exist")).toBeNull();
  });
});
