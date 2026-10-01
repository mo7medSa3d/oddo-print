import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PATCH as configurationPATCH } from "../src/app/api/odoo/configuration/route";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("Odoo Gateway configuration billing race", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    await pool().query(
      "UPDATE api_keys SET odoo_enabled = false, odoo_enabled_revision = 0 WHERE tenant_id = $1",
      [fixture.tenantId],
    );
  });

  it("does not enable Gateway printing after a concurrent subscription cancellation wins the billing row lock", async () => {
    const locker = await pool().connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT tenant_id FROM tenant_subscriptions WHERE tenant_id = $1 FOR UPDATE",
        [fixture.tenantId],
      );

      const responsePromise = configurationPATCH(
        new Request("http://gateway.test/api/odoo/configuration", {
          method: "PATCH",
          headers: {
            "x-api-key": fixture.odooKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled: true, revision: 1 }),
        }),
      );

      // The repaired route must be blocked on the same subscription-row lock
      // before it can mutate api_keys. The old pre-check version did not lock
      // this row and could commit enabled=true while cancellation was pending.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beforeRelease = await pool().query(
        "SELECT odoo_enabled, odoo_enabled_revision FROM api_keys WHERE tenant_id = $1",
        [fixture.tenantId],
      );
      expect(beforeRelease.rows[0]).toMatchObject({
        odoo_enabled: false,
        odoo_enabled_revision: 0,
      });

      await locker.query(
        "UPDATE tenant_subscriptions SET status = 'cancelled', current_period_end = now() - interval '1 second' WHERE tenant_id = $1",
        [fixture.tenantId],
      );
      await locker.query("COMMIT");

      const response = await responsePromise;
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "TENANT_SUBSCRIPTION_REQUIRED",
      });

      const after = await pool().query(
        "SELECT odoo_enabled, odoo_enabled_revision FROM api_keys WHERE tenant_id = $1",
        [fixture.tenantId],
      );
      expect(after.rows[0]).toMatchObject({
        odoo_enabled: false,
        odoo_enabled_revision: 0,
      });
    } catch (error) {
      try { await locker.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      locker.release();
    }
  });

  it("still allows disabling the replicated Odoo activation state after subscription cancellation", async () => {
    await pool().query(
      "UPDATE api_keys SET odoo_enabled = true, odoo_enabled_revision = 1 WHERE tenant_id = $1",
      [fixture.tenantId],
    );
    await pool().query(
      "UPDATE tenant_subscriptions SET status = 'cancelled', current_period_end = now() - interval '1 second' WHERE tenant_id = $1",
      [fixture.tenantId],
    );

    const response = await configurationPATCH(
      new Request("http://gateway.test/api/odoo/configuration", {
        method: "PATCH",
        headers: {
          "x-api-key": fixture.odooKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false, revision: 2 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      applied: true,
      enabled: false,
      revision: 2,
    });
  });
});
