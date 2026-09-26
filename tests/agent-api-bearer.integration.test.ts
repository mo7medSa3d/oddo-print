import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, closePool, pool } from "./helpers/pg";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { createManagerSession } from "../src/lib/manager-auth";
import { POST as agentsPOST } from "../src/app/api/agents/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("agent creation HTTP authentication boundary", () => {
  const tenantId = "tenant_agent_bearer_contract";

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    await pool().query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, "Agent Bearer Contract"]);
    await pool().query(
      `INSERT INTO plans (id, name, entitlements) VALUES ('plan_agent_bearer', 'Test', '{"max_agents":"unlimited","max_printers":"unlimited","max_jobs_per_minute":"unlimited","max_concurrent_jobs":"unlimited","max_prints_per_period":"unlimited"}'::jsonb)`,
    );
    await pool().query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, current_period_end) VALUES ($1, 'plan_agent_bearer', 'active', NULL)`,
      [tenantId],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("accepts a valid manager bearer request without requiring a browser cookie", async () => {
    const session = await createManagerSession(tenantId);
    const response = await agentsPOST(new Request("http://gateway.test/api/agents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Bearer-authenticated Agent" }),
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toMatch(/^agt_/);

    const row = (await pool().query(
      `SELECT tenant_id, name, lifecycle FROM agents WHERE id = $1`,
      [body.id],
    )).rows[0];
    expect(row).toMatchObject({ tenant_id: tenantId, name: "Bearer-authenticated Agent", lifecycle: "active" });
  });
});
