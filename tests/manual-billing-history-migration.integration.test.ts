import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { migrateByHash } from "../scripts/db-migrate";

const hasTestDatabase = Boolean(process.env.DATABASE_URL);
describe.skipIf(!hasTestDatabase)("manual billing clean baseline preservation", () => {
  let admin: Pool, target: Pool, database: string;
  async function migrate(folder: string) {
    const client = await target.connect();
    try { await migrateByHash(client, folder); } finally { client.release(); }
  }
  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL!); source.pathname = "/postgres";
    admin = new Pool({ connectionString: source.href, max: 1 });
    database = `billing_history_${randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    source.pathname = `/${database}`;
    target = new Pool({ connectionString: source.href, max: 2, options: "-c timezone=UTC" });
    await migrate(join(process.cwd(), "drizzle"));
  });
  afterAll(async () => {
    await target?.end();
    try { if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`); }
    finally { await admin?.end(); }
  });
  it("stores manual-only billing records cleanly and preserves checksum and ledger on replay", async () => {
    const published = await readFile("drizzle/0000_initial_schema.sql", "utf8");
    await target.query(`INSERT INTO tenants(id,name) VALUES ('manual-tenant','Manual tenant')`);
    await target.query(
      `INSERT INTO plans(id,name,entitlements,price_minor_units,price_currency)
       VALUES ('manual-plan','Manual plan','{"max_agents":5,"max_printers":10,"max_jobs_per_minute":60,"max_concurrent_jobs":10,"max_prints_per_period":5000}'::jsonb,50000,'SAR')`,
    );
    await target.query(
      `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,subscription_type,monthly_quota,term,internal_reference,revision,current_period_start,current_period_end)
       VALUES ('manual-tenant','manual-plan','active','paid',5000,'monthly','INV-2026-001',1,now()-interval '1 minute',now()+interval '30 days')`,
    );

    const beforePlans = (await target.query("SELECT id,name,price_minor_units,price_currency FROM plans ORDER BY id")).rows;
    const beforeSubs = (await target.query("SELECT tenant_id,plan_id,status,subscription_type,monthly_quota,term,internal_reference,revision FROM tenant_subscriptions ORDER BY tenant_id")).rows;
    const ledger = (await target.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
    expect(ledger).toHaveLength(1);

    await migrate(join(process.cwd(), "drizzle"));

    expect(await readFile("drizzle/0000_initial_schema.sql", "utf8")).toBe(published);
    expect((await target.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(ledger);
    expect((await target.query("SELECT id,name,price_minor_units,price_currency FROM plans ORDER BY id")).rows).toEqual(beforePlans);
    expect((await target.query("SELECT tenant_id,plan_id,status,subscription_type,monthly_quota,term,internal_reference,revision FROM tenant_subscriptions ORDER BY tenant_id")).rows).toEqual(beforeSubs);
  });
});
