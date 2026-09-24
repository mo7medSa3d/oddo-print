import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { POST as heartbeatPOST } from "../src/app/api/agent/heartbeat/route";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function makePrinter(id: string) {
  return {
    id,
    name: id,
    printerType: "physical",
    deviceClass: "other",
    connectionType: "network",
    protocol: "raw",
    status: "online",
    config: { ip: "10.0.0.10", port: 9100 },
    capabilities: { supported_protocols: ["raw"] },
  };
}

async function heartbeat(agentAuth: string, body: unknown) {
  return heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
    method: "POST",
    headers: {
      authorization: agentAuth,
      "content-type": "application/json",
      "x-real-ip": "127.0.0.40",
    },
    body: JSON.stringify(body),
  }));
}

suite("agent heartbeat pagination contract", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it("accepts 501 printers across multiple pages without truncating inventory", async () => {
    const f = await seedFixture();
    const pageOne = Array.from({ length: 500 }, (_, i) => makePrinter(`hb-${String(i).padStart(4, "0")}`));
    const pageTwo = [makePrinter("hb-0500")];

    const first = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 1,
      heartbeatPageCount: 2,
      printers: pageOne,
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.desiredState).toBeUndefined();

    const second = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 2,
      heartbeatPageCount: 2,
      printers: pageTwo,
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(Array.isArray(secondBody.desiredState)).toBe(true);

    const rows = await pool().query(
      `SELECT id
       FROM printers
       WHERE tenant_id = $1 AND id LIKE 'hb-%'
       ORDER BY id`,
      [f.tenantId],
    );
    expect(rows.rows.map((row) => row.id)).toHaveLength(501);
  });

  it("rejects invalid page metadata before touching the tenant inventory", async () => {
    const f = await seedFixture();
    const response = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 2,
      heartbeatPageCount: 1,
      printers: [makePrinter("hb-invalid-page")],
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("heartbeatPage"),
    });

    const rows = await pool().query(
      `SELECT COUNT(*)::int AS count
       FROM printers
       WHERE tenant_id = $1 AND id = 'hb-invalid-page'`,
      [f.tenantId],
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("enforces max_printers when heartbeat discovers new agent-owned printers", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE plans
       SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb)
       WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)`,
      [f.tenantId],
    );

    const response = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 1,
      heartbeatPageCount: 1,
      printers: [makePrinter("hb-over-limit")],
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: "MAX_PRINTERS_EXCEEDED",
      entitlement: "max_printers",
      limit: 1,
      upgradeRequired: true,
    });

    const rows = await pool().query(
      `SELECT COUNT(*)::int AS count
       FROM printers
       WHERE tenant_id = $1 AND id = 'hb-over-limit'`,
      [f.tenantId],
    );
    expect(rows.rows[0].count).toBe(0);
  });
});
