import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, pool, closePool } from "./helpers/pg";
import { POST as discoveryReport } from "../src/app/api/agent/discovery/route";

describe.skipIf(!hasTestDatabase)("discovery identity deduplication at the actual ingestion boundary", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  it("stores one logical device for multiple observations with the same stable identity", async () => {
    await truncateAll();
    const fixture = await seedFixture();
    await pool().query("INSERT INTO discovery_sessions (id, tenant_id, agent_id, status, config, stats) VALUES ('disc_identity_dedupe', $1, $2, 'running', '{}'::jsonb, '{}'::jsonb)", [fixture.tenantId, fixture.agentId]);
    const response = await discoveryReport(new Request("https://gateway.test/api/agent/discovery", { method: "POST", headers: { Authorization: fixture.agentAuth, "Content-Type": "application/json" }, body: JSON.stringify({ discoveryId: "disc_identity_dedupe", status: "completed", devices: ["mdns", "ipp", "snmp"].map(source => ({ id: "observed-" + source, stableId: "same-physical-printer", source: [source], protocol: "ipp", ipAddress: "192.168.1.50", port: 631 })) }) }));
    expect(response.status).toBe(200);
    const rows = await pool().query("SELECT identity_key, source FROM discovered_devices WHERE tenant_id=$1 AND agent_id=$2", [fixture.tenantId, fixture.agentId]);
    expect(rows.rows).toEqual([{ identity_key: "same-physical-printer", source: ["snmp"] }]);
  });
});
