import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as agentsGET } from "../src/app/api/odoo/agents/route";
import { GET as printersGET } from "../src/app/api/odoo/printers/route";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("Odoo runtime discovery billing boundary", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  it("keeps agent discovery available during past_due recovery after nominal period end", async () => {
    await pool().query(
      "UPDATE tenant_subscriptions SET status = 'past_due', current_period_end = now() - interval '1 minute' WHERE tenant_id = $1",
      [fixture.tenantId],
    );

    const response = await agentsGET(
      new Request("https://gateway.test/api/odoo/agents", {
        headers: { "x-api-key": fixture.odooKey },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agents: [{ id: fixture.agentId, lifecycle: "active" }],
    });
  });

  it("blocks printer inventory discovery after subscription cancellation", async () => {
    await pool().query(
      "UPDATE tenant_subscriptions SET status = 'cancelled', current_period_end = now() - interval '1 minute' WHERE tenant_id = $1",
      [fixture.tenantId],
    );

    const response = await printersGET(
      new Request("https://gateway.test/api/odoo/printers", {
        headers: { "x-api-key": fixture.odooKey },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
    });
  });
});
