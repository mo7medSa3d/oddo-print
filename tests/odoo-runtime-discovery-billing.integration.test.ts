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

  it("publishes bounded selected roll media separately from printable dots", async () => {
    await pool().query(
      "UPDATE printers SET capabilities = $1::jsonb WHERE tenant_id = $2 AND id = $3",
      [JSON.stringify({ paper_width_mm: 58, max_paper_width: 384, supported_protocols: ["pdf", "image"] }), fixture.tenantId, fixture.printerId],
    );
    const request = () => new Request("https://gateway.test/api/odoo/printers", { headers: { "x-api-key": fixture.odooKey } });
    const response = await printersGET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.printers.find((printer: { id: string }) => printer.id === fixture.printerId)).toMatchObject({
      capabilities: { paper_width_mm: 58 }, printableWidthDots: 384,
    });
    await pool().query(
      "UPDATE printers SET capabilities = $1::jsonb, config = '{}'::jsonb WHERE tenant_id = $2 AND id = $3",
      [JSON.stringify({ max_paper_width: 512, paper_widths: [58, 80] }), fixture.tenantId, fixture.printerId],
    );
    const ambiguous = await (await printersGET(request())).json();
    expect(ambiguous.printers.find((printer: { id: string }) => printer.id === fixture.printerId).capabilities).not.toHaveProperty("paper_width_mm");
  });
});
