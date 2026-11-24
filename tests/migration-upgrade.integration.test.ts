import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, cp, mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { AUDIT_REPAIRS, migrateByHash } from "../scripts/db-migrate";
import { readMigrationFiles } from "drizzle-orm/migrator";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!hasDatabase);
// The license-only control plane retired the printing runtime tables.
const migrationsHavePrinting = readdirSync(join(process.cwd(), "drizzle"))
  .filter((file) => file.endsWith(".sql"))
  .some((file) => readFileSync(join(process.cwd(), "drizzle", file), "utf8").includes("print_jobs"));
const printingIt = migrationsHavePrinting ? it : it.skip;

function databaseUrlFor(name: string): string {
  const source = new URL(process.env.DATABASE_URL!);
  source.pathname = `/${name}`;
  return source.toString();
}

suite("production-like PostgreSQL migration upgrade", () => {
  let admin: Pool;
  let tempDb = "";
  let collisionDb = "";
  let workDir = "";
  let currentDir = "";
  let forwardDir = "";

  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL!);
    const adminUrl = new URL(source.toString());
    adminUrl.pathname = "/postgres";
    tempDb = `upgrade_${Date.now()}_${randomBytes(3).toString("hex")}`;
    collisionDb = `${tempDb}_collision`;
    admin = new Pool({ connectionString: adminUrl.toString(), max: 2 });
    admin.on("error", () => {});
    await admin.query(`CREATE DATABASE "${tempDb}"`);
    await admin.query(`CREATE DATABASE "${collisionDb}"`);

    workDir = await mkdtemp(join(tmpdir(), "odoo-print-upgrade-"));
    currentDir = join(workDir, "current");
    forwardDir = join(workDir, "forward");
    await mkdir(join(currentDir, "meta"), { recursive: true });
    await mkdir(join(forwardDir, "meta"), { recursive: true });

    const migrations = (await readdir("drizzle")).filter((f) => f.endsWith(".sql")).sort();
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints?: boolean }>;
    };
    await writeFile(join(currentDir, "meta", "_journal.json"), JSON.stringify(journal));
    for (const file of migrations) {
      await cp(join("drizzle", file), join(currentDir, file));
      await cp(join("drizzle", file), join(forwardDir, file));
    }

    const nextIdx = journal.entries.length;
    const additiveTag = "9999_forward_upgrade_probe";
    await writeFile(join(forwardDir, `${additiveTag}.sql`), "SELECT 1;\n");
    await writeFile(
      join(forwardDir, "meta", "_journal.json"),
      JSON.stringify({
        ...journal,
        entries: [
          ...journal.entries,
          { idx: nextIdx, version: journal.version, when: Date.now(), tag: additiveTag, breakpoints: true },
        ],
      }),
    );
  });

  afterAll(async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${tempDb}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${collisionDb}"`);
    } finally {
      await admin.end();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  printingIt("fresh public migrations ignore colliding constraints in another namespace and preserve original ledger hashes", async () => {
    const pool = new Pool({ connectionString: databaseUrlFor(collisionDb), max: 2 });
    pool.on("error", () => {});
    try {
      await pool.query("CREATE SCHEMA migration_collision");
      await pool.query("CREATE TABLE migration_collision.agents (tenant_id text, id text, CONSTRAINT agents_tenant_id_unique UNIQUE(tenant_id,id))");
      const client = await pool.connect();
      try {
        await client.query("SET search_path TO migration_collision,public");
        await migrateByHash(client, currentDir);
        expect((await client.query("SELECT current_schema() AS schema")).rows[0].schema).toBe("migration_collision");
      } finally { client.release(); }
      const columns = await pool.query("SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name IN ('shared_with_gateway','shared_with_gateway_version') ORDER BY column_name");
      expect(columns.rows).toEqual([
        { column_name: "shared_with_gateway", is_nullable: "NO", column_default: "true" },
        { column_name: "shared_with_gateway_version", is_nullable: "YES", column_default: null },
      ]);
      const sourceMigrations = readMigrationFiles({ migrationsFolder: currentDir });
      const expectedHashes = sourceMigrations.map(row => row.hash).concat(AUDIT_REPAIRS.map(sql => createHash("sha256").update(sql).digest("hex")));
      const before = (await pool.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      expect(before.map(row => row.hash)).toEqual(expectedHashes);
      const journal = JSON.parse(await readFile(join(currentDir, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
      expect(sourceMigrations).toHaveLength(journal.entries.length);
      expect(journal.entries.map(entry => entry.tag)).toContain("0000_initial_schema");
      await pool.query("INSERT INTO public.tenants(id,name) VALUES ('sharing_upgrade_tenant','Upgrade proof')");
      await pool.query("INSERT INTO public.agents(id,tenant_id,name) VALUES ('sharing_upgrade_agent','sharing_upgrade_tenant','Upgrade Agent')");
      await pool.query("INSERT INTO public.printers(id,tenant_id,agent_id,name,shared_with_gateway,shared_with_gateway_version) VALUES ('sharing_upgrade_printer','sharing_upgrade_tenant','sharing_upgrade_agent','Physical upgrade queue',false,'9223372036854775807')");
      await expect(pool.query("UPDATE public.printers SET shared_with_gateway_version='9223372036854775808' WHERE id='sharing_upgrade_printer'")).rejects.toThrow(/printers_sharing_version_check/);
      const replay = await pool.connect();
      try { await migrateByHash(replay, currentDir); } finally { replay.release(); }
      expect((await pool.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(before);
      expect((await pool.query("SELECT shared_with_gateway,shared_with_gateway_version,lifecycle FROM public.printers WHERE id='sharing_upgrade_printer'")).rows).toEqual([
        { shared_with_gateway: false, shared_with_gateway_version: "9223372036854775807", lifecycle: "active" },
      ]);
      const constraints = await pool.query("SELECT n.nspname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.conname='agents_tenant_id_unique' ORDER BY n.nspname");
      expect(constraints.rows.map(row => row.nspname)).toEqual(["migration_collision", "public"]);
    } finally { await pool.end(); }
  });

  printingIt("enforces clean runtime-only schema invariants and preserves populated rows across forward migrations", async () => {
    const pool = new Pool({ connectionString: databaseUrlFor(tempDb), max: 4 });
    pool.on("error", () => {});
    try {
      const initialClient = await pool.connect();
      try { await migrateByHash(initialClient, currentDir); } finally { initialClient.release(); }

      const legacyTables = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('branches','destinations','document_types','local_networks','printer_bindings','e2e_capture_runs')
      `);
      expect(legacyTables.rows).toEqual([]);

      const legacyBillingColumns = await pool.query(`
        SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('plans','tenant_subscriptions')
          AND (
            column_name LIKE 'stripe_%'
            OR column_name LIKE 'checkout_%'
            OR column_name LIKE 'billing_operation_%'
            OR column_name IN ('billing_mode','trial_started_at','currency','interval')
          )
      `);
      expect(legacyBillingColumns.rows).toEqual([]);

      const activeColumns = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tenant_subscriptions'
          AND column_name IN ('plan_id','monthly_quota','subscription_type','term','internal_reference','revision','current_period_end')
      `);
      expect(activeColumns.rowCount).toBe(7);

      const uniqueIndex = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='print_jobs' AND indexname='print_jobs_tenant_idempotency_unique'`);
      expect(uniqueIndex.rowCount).toBe(1);
      const trigger = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='print_jobs'::regclass AND tgname='print_jobs_notify_agent_job_available'`);
      expect(trigger.rowCount).toBe(1);

      const invariants = await pool.query(`
        SELECT
          (SELECT count(*) FROM information_schema.columns WHERE table_name='print_jobs' AND column_name='claim_token') AS claim_token_col,
          (SELECT count(*) FROM pg_constraint WHERE conname='print_jobs_payload_contract_check') AS payload_check,
          (SELECT count(*) FROM pg_constraint WHERE conname='printers_protocol_check' AND pg_get_constraintdef(oid) LIKE '%unknown%') AS proto_unknown_check
      `);
      expect(invariants.rows[0]).toMatchObject({
        claim_token_col: "1",
        payload_check: "1",
        proto_unknown_check: "1",
      });

      const tenantId = "tenant_forward_fixture";
      const agentId = "agent_forward_fixture";
      const printerId = "printer_forward_fixture";
      const freeform = "مطبخ النخيل / external-label ' original";
      await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Forward fixture')", [tenantId]);
      await pool.query("INSERT INTO agents(id,tenant_id,name,secret,status,lifecycle) VALUES ($1,$2,'Forward Agent','secret-hash','online','active')", [agentId, tenantId]);
      await pool.query(
        "INSERT INTO printers(id,tenant_id,agent_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle) VALUES ($1,$2,$3,'Spooler Queue','physical','other','spooler','windows_spooler','online','active')",
        [printerId, tenantId, agentId],
      );
      await expect(
        pool.query(
          `INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at)
           VALUES ('job_bad_contract', $1, $2, $3, 'queued', '{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`,
          [tenantId, agentId, printerId],
        ),
      ).rejects.toThrow(/constraint|check/i);
      await pool.query(
        `INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, destination, status, payload, expires_at)
         VALUES ('job_good_contract', $1, $2, $3, $4, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`,
        [tenantId, agentId, printerId, freeform],
      );
      await pool.query("INSERT INTO discovery_sessions (id, tenant_id, agent_id, status) VALUES ('disc_forward_fixture', $1, $2, 'completed')", [tenantId, agentId]);
      await pool.query("INSERT INTO discovered_devices (id, tenant_id, discovery_id, agent_id, protocol) VALUES ('dev_zpl_fixture', $1, 'disc_forward_fixture', $2, 'zpl'), ('dev_tspl_fixture', $1, 'disc_forward_fixture', $2, 'tspl')", [tenantId, agentId]);

      const beforeLedger = (await pool.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      const forwardClient = await pool.connect();
      try { await migrateByHash(forwardClient, forwardDir); } finally { forwardClient.release(); }
      const afterLedger = (await pool.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      expect(afterLedger.slice(0, beforeLedger.length)).toEqual(beforeLedger);
      expect(afterLedger.map(row => row.hash)).toEqual(
        readMigrationFiles({ migrationsFolder: forwardDir }).map(row => row.hash)
          .concat(AUDIT_REPAIRS.map(sql => createHash("sha256").update(sql).digest("hex"))),
      );

      expect((await pool.query("SELECT id,destination FROM print_jobs WHERE id='job_good_contract'")).rows).toEqual([
        { id: "job_good_contract", destination: freeform },
      ]);
      const devprotos = await pool.query("SELECT protocol FROM discovered_devices WHERE id IN ('dev_zpl_fixture','dev_tspl_fixture') ORDER BY protocol");
      expect(devprotos.rows.map((r) => r.protocol)).toEqual(["tspl", "zpl"]);

      const replay = await pool.connect();
      try { await migrateByHash(replay, forwardDir); } finally { replay.release(); }
      expect((await pool.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(afterLedger);
    } finally { await pool.end(); }
  });
});
