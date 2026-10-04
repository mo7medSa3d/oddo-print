import { readMigrationFiles } from "drizzle-orm/migrator";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { runtimeSecret } from "../src/lib/runtime-secret";


// Forward repairs live here because this audit may not add migration files.
// Append versioned entries; never edit historical SQL/hash identities.
export const AUDIT_REPAIRS: readonly string[] = [
  `-- audit A98 v1: preserve catalog price identities used by existing subscriptions
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_price_history text[] NOT NULL DEFAULT ARRAY[]::text[];
UPDATE plans SET stripe_price_history = ARRAY[stripe_price_id] WHERE stripe_price_id IS NOT NULL AND stripe_price_history = ARRAY[]::text[];`,
  `-- audit A96 v1: fence fetched Stripe snapshots across concurrent commits
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_state_revision bigint NOT NULL DEFAULT 0;`,
  `-- audit A97 v1: immutable Stripe checkout request snapshot
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS checkout_request_params jsonb;`,
  `-- audit A97 v2: bound recovery below Stripe idempotency retention
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS checkout_intent_created_at timestamp;`,
  `-- audit A62 v1: closed attempt acknowledgement evidence
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS closed_claim_token_hash text;`,
  `-- audit A158 v1: reject absent/null payload discriminators on all new writes
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_payload_contract_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_payload_contract_check CHECK (
  jsonb_typeof(payload) = 'object' AND (
    (COALESCE(payload->>'type', '') = 'raw' AND COALESCE(payload->>'protocol', '') IN ('raw','escpos','zpl','tspl'))
    OR (COALESCE(payload->>'type', '') = 'escpos' AND COALESCE(payload->>'protocol', '') = 'escpos')
    OR (COALESCE(payload->>'type', '') = 'pdf' AND COALESCE(payload->>'protocol', '') = '')
    OR (COALESCE(payload->>'type', '') = 'image' AND COALESCE(payload->>'protocol', '') = '')
  )
) NOT VALID;`,
  `-- audit A86 v1: retain payload-free completion and idempotency evidence
CREATE TABLE IF NOT EXISTS print_job_receipts (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 idempotency_key text, fingerprint text NOT NULL, printer_id text NOT NULL, agent_id text NOT NULL,
 api_key_id text, destination text, document_type text, requested_by text NOT NULL,
 status text NOT NULL CHECK (status IN ('success','failed','expired')), error text, closed_claim_token_hash text,
 delivered_at timestamp, acked_at timestamp, created_at timestamp NOT NULL, updated_at timestamp NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS print_job_receipts_tenant_idempotency_unique ON print_job_receipts(tenant_id,idempotency_key);`,
  `-- audit A86 v2: preserve nullable historical requester metadata
ALTER TABLE print_job_receipts ALTER COLUMN requested_by DROP NOT NULL;`,
];

/** Apply journal order by recorded content hash, including skipped older timestamps. */
export async function migrateByHash(client: PoolClient, migrationsFolder: string): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || current_schema() || ':migrations'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    const history = await client.query<{ hash: string }>('SELECT hash FROM drizzle.__drizzle_migrations');
    const applied = new Set(history.rows.map(row => row.hash));
    for (const migration of migrations) {
      if (applied.has(migration.hash)) continue;
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [migration.hash, migration.folderMillis]);
      applied.add(migration.hash);
    }
    for (const repair of AUDIT_REPAIRS) {
      const hash = createHash("sha256").update(repair).digest("hex");
      if (applied.has(hash)) continue;
      await client.query(repair);
      await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [hash, Math.max(...migrations.map(m => m.folderMillis))]);
      applied.add(hash);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const hasDatabaseSettings = Boolean(
    runtimeSecret("DATABASE_URL") ||
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER ||
    runtimeSecret("PGPASSWORD"),
  );
  if (!hasDatabaseSettings) {
    throw new Error("PostgreSQL connection settings are required");
  }
  const { pool } = await import("../src/db");
  const client = await pool.connect();
  try { await migrateByHash(client, "./drizzle"); }
  finally { client.release(); }
  console.log("PostgreSQL migrations applied successfully");
  await pool.end();
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async (e) => {
  console.error(e);
  const { pool } = await import("../src/db");
  await pool.end().catch(() => {});
  process.exit(1);
});
