import { readFileSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { defaults, Pool, types, type PoolConfig } from "pg";
import { AUDIT_REPAIRS } from "../../scripts/db-migrate";
import { getWorkerSchema, schemaSearchPath } from "../../src/lib/worker-schema";
import { parseDbTimeMs } from "../../src/lib/database-timestamp";

// Match the Gateway's UTC-naive storage convention for raw fixture Dates.
defaults.parseInputDatesAsUTC = true;

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

let adminPool: Pool | null = null;
let workerSchema: string | null | undefined = undefined;
let migrationPromise: Promise<void> | null = null;

function getOrCreateWorkerSchema(): string | null {
  if (workerSchema !== undefined) return workerSchema;
  workerSchema = getWorkerSchema();
  return workerSchema;
}
function quoteIdent(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
export function pool(): Pool {
  if (!adminPool) {
    const schema = getOrCreateWorkerSchema();
    const config: PoolConfig = {
      connectionString: TEST_DATABASE_URL, max: 8, options: "-c timezone=UTC",
      types: {
        getTypeParser(oid, format) {
          const parser = types.getTypeParser(oid, format);
          if (oid !== types.builtins.TIMESTAMP || format === "binary") return parser;
          return (value: string) => {
            const ms = parseDbTimeMs(value);
            return ms === null ? parser(value) : new Date(ms);
          };
        },
      },
    };
    if (schema) config.options += ` -c search_path=${schemaSearchPath(schema)}`;
    adminPool = new Pool(config);
  }
  return adminPool;
}

const GLOBAL_PG_LOCK = 727727;
export function billingArchiveSchema(): string {
  const schema = getOrCreateWorkerSchema();
  if (!schema) return "legacy_billing";
  return `test_billing_archive_${createHash("sha256").update(schema).digest("hex").slice(0, 20)}`;
}
function rewriteMigrationForSchema(sql: string, schema: string | null): string {
  if (!schema) return sql;
  const quotedSchema = quoteIdent(schema);
  return sql
    .replaceAll(/\blegacy_billing\b/g, quoteIdent(billingArchiveSchema()))
    .replaceAll('"public".', `${quotedSchema}.`)
    .replaceAll(/\bpublic\./g, `${schema}.`)
    .replaceAll(
      /FROM pg_constraint WHERE conname =/g,
      `FROM pg_constraint WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}') AND conname =`
    );
}

async function applyMigrationsOnce(): Promise<void> {
  const schema = getOrCreateWorkerSchema();
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      if (schema) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(billingArchiveSchema())} CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
        await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
        await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      }
      await client.query("BEGIN");
      const dir = path.resolve(process.cwd(), "drizzle");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const sqlText = rewriteMigrationForSchema(readFileSync(path.join(dir, file), "utf8"), schema);
        for (const statement of sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      for (const repair of AUDIT_REPAIRS) {
        await client.query(rewriteMigrationForSchema(repair, schema));
      }
      const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'print_jobs'`);
      // The license-only control-plane schema retires print_jobs; validate its
      // columns only for schemas that still deploy the printing runtime.
      if (columns.rowCount) {
        const names = new Set(columns.rows.map((row: { column_name: string }) => row.column_name));
        for (const required of ["destination", "agent_id", "printer_id", "idempotency_key", "delivery_attempts"]) {
          if (!names.has(required)) throw new Error(`test database is missing print_jobs.${required}`);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally { client.release(); }
}
export async function applyMigrations(): Promise<void> {
  if (!migrationPromise) migrationPromise = applyMigrationsOnce().catch((error) => { migrationPromise = null; throw error; });
  await migrationPromise;
}
export async function truncateAll(): Promise<void> {
  const schema = getOrCreateWorkerSchema();
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      // Use DELETE instead of TRUNCATE CASCADE to avoid heavy DataFileImmediateSync I/O stalls on test environments
      const orderedTables = [
        "subscription_requests",
        "subscription_changes",
        "odoo_installation_credentials",
        "odoo_installations",
        "manager_sessions",
        "refresh_tokens",
        "email_verification_tokens",
        "password_reset_tokens",
        "tenant_invitations",
        "platform_sessions",
        "platform_session_security",
        "workspace_session_security",
        "tenant_subscriptions",
        "audit_events",
        "api_keys",
        "tenant_users",
        "auth_rate_limits",
        "users",
        "tenants",
        "plans",
        "gateway_metrics",
      ];
      for (const table of orderedTables) {
        try { await client.query(`DELETE FROM ${quoteIdent(table)}`); } catch (error: any) { if (error?.code !== "42P01") throw error; }
      }
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {} }
  } finally { client.release(); }
}
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export type Fixture = { tenantId: string; agentId: string; agentSecret: string; agentAuth: string; printerId: string; destination: string; odooKey: string };

export async function seedFixture(opts?: {
  printerCapabilities?: unknown;
  // Existing integration tests intentionally exercise the historical v1 path.
  // New-v2 tests must opt into a fresh strict_v2 fixture explicitly; the
  // real PostgreSQL default for fresh production tenants remains strict_v2.
  odooIdempotencyMode?: "legacy" | "strict_v2";
}): Promise<Fixture> {
  const suffix = randomBytes(8).toString("hex");
  const agentId = `agt_${randomBytes(6).toString("base64url").slice(0, 8)}`;
  const agentSecret = randomBytes(16).toString("base64url");
  const printerId = `printer_${suffix}`;
  const destination = `POS ${suffix}`;
  const odooKey = `odoo_${randomBytes(18).toString("base64url")}`;
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      const schema = getOrCreateWorkerSchema();
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      const tenantId = `tenant_${suffix}`;
      await client.query(
        `INSERT INTO tenants (id, name, odoo_idempotency_mode) VALUES ($1, $2, $3)`,
        [tenantId, `Tenant ${suffix}`, opts?.odooIdempotencyMode ?? "legacy"],
      );
      // Entitlement enforcement is fail-closed: every print-job admission
      // requires an eligible subscription with canonical limits. Fixtures
      // carry an active unlimited plan so job/print tests exercise delivery,
      // not entitlement rejection (dedicated entitlement tests cover 403/429).
      await client.query(
        `INSERT INTO plans (id, name, entitlements) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
        [`plan_${suffix}`, `Plan ${suffix}`, JSON.stringify({ max_agents: "unlimited", max_printers: "unlimited", max_jobs_per_minute: "unlimited", max_concurrent_jobs: "unlimited", max_prints_per_period: "unlimited" })],
      );
      await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end) VALUES ($1, $2, 'active', now() - interval '1 minute', now() + interval '1 year') ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end`,
        [tenantId, `plan_${suffix}`],
      );
      // Legacy agents and printers tables were removed in the 21-table license-only schema.
      await client.query(`INSERT INTO api_keys (id, tenant_id, name, hashed_key, odoo_enabled, odoo_enabled_revision) VALUES ($1, $2, 'test key', $3, true, 0)`, [`key_${suffix}`, tenantId, sha256(odooKey)]);
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {} }
  } finally { client.release(); }
  return { tenantId: `tenant_${suffix}`, agentId, agentSecret, agentAuth: `Bearer ${agentId}:${agentSecret}`, printerId, destination, odooKey };
}

export async function insertQueuedJob(_f: Fixture, _jobId: string, _opts?: { expiresInMs?: number }): Promise<void> {
  throw new Error("print_jobs table was retired in the 21-table license-only control plane schema");
}
export async function jobRow(_jobId: string): Promise<any> {
  throw new Error("print_jobs table was retired in the 21-table license-only control plane schema");
}
export async function closePool(): Promise<void> { if (adminPool) { await adminPool.end(); adminPool = null; } }
