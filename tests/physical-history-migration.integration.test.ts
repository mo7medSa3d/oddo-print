import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { migrateByHash } from "../scripts/db-migrate";

const hasTestDatabase = Boolean(process.env.DATABASE_URL);
const DROPPED_TABLES = [
  "agents",
  "printers",
  "print_jobs",
  "print_job_receipts",
  "print_monthly_usage",
  "job_events",
  "discovered_devices",
  "discovery_sessions",
  "odoo_v2_operations",
  "odoo_legacy_resolutions",
  "tenant_domains",
];

describe.skipIf(!hasTestDatabase)("21-table license-only clean baseline enforcement", () => {
  let admin: Pool, target: Pool, database: string;
  async function migrate(folder: string) {
    const client = await target.connect();
    try { await migrateByHash(client, folder); } finally { client.release(); }
  }
  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL!); source.pathname = "/postgres";
    admin = new Pool({ connectionString: source.href, max: 1 });
    database = `license_baseline_${randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    source.pathname = `/${database}`;
    target = new Pool({ connectionString: source.href, max: 2 });
    await migrate(join(process.cwd(), "drizzle"));
  });
  afterAll(async () => {
    await target?.end();
    try { if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`); }
    finally { await admin?.end(); }
  });
  it("applies the 21-table license-only schema idempotently and excludes dropped cloud-print tables", async () => {
    const published = await readFile("drizzle/0000_initial_schema.sql", "utf8");
    const tablesRes = await target.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const tableNames = tablesRes.rows.map((r: { table_name: string }) => r.table_name);
    expect(tableNames).toHaveLength(21);
    for (const dropped of DROPPED_TABLES) {
      expect(tableNames).not.toContain(dropped);
    }

    await target.query("INSERT INTO tenants(id,name) VALUES ('retained','Retained')");
    await target.query(
      "INSERT INTO odoo_installations(id,tenant_id,name,secret_hash) VALUES ('inst-1','retained','Main Odoo','hash1')",
    );
    await target.query(
      "INSERT INTO api_keys(id,tenant_id,name,hashed_key,odoo_enabled,odoo_enabled_revision) VALUES ('key-1','retained','Key','khash',true,0)",
    );
    await target.query(
      "INSERT INTO odoo_installation_credentials(tenant_id,installation_id,api_key_id) VALUES ('retained','inst-1','key-1')",
    );

    const ledger = (await target.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
    expect(ledger).toHaveLength(1);
    await migrate(join(process.cwd(), "drizzle"));

    expect(await readFile("drizzle/0000_initial_schema.sql", "utf8")).toBe(published);
    expect((await target.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(ledger);
    for (const table of ["odoo_installations", "api_keys", "odoo_installation_credentials"]) {
      expect((await target.query(`SELECT tenant_id FROM ${table} WHERE tenant_id='retained'`)).rows).toHaveLength(1);
    }
  });
});
