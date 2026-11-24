import { readMigrationFiles } from "drizzle-orm/migrator";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { runtimeSecret } from "../src/lib/runtime-secret";

// All schema tables, constraints, indexes, and triggers live in the clean
// initial migration (drizzle/0000_initial_schema.sql). Keep AUDIT_REPAIRS
// exported for migration harness callers.
export const AUDIT_REPAIRS: readonly string[] = [];

/** Scope legacy name-only guards without changing stored migration SQL/hashes. */
export function scopeMigrationConstraintGuards(statement: string): string {
  return statement.replaceAll(
    /FROM pg_constraint WHERE conname =/g,
    "FROM pg_constraint WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema()) AND conname =",
  );
}

export async function resetDatabaseSchema(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrateByHash(client: PoolClient, migrationsFolder: string): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path TO public");
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    await client.query("LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE");
    const existing = await client.query<{ hash: string }>(
      "SELECT hash FROM drizzle.__drizzle_migrations",
    );
    const applied = new Set(existing.rows.map((row) => row.hash));
    for (const migration of migrations) {
      if (applied.has(migration.hash)) continue;
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(scopeMigrationConstraintGuards(statement));
      }
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [migration.hash, migration.folderMillis],
      );
      applied.add(migration.hash);
    }
    for (const repair of AUDIT_REPAIRS) {
      const hash = createHash("sha256").update(repair).digest("hex");
      if (applied.has(hash)) continue;
      await client.query(repair);
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [hash, Math.max(0, ...migrations.map((m) => m.folderMillis))],
      );
      applied.add(hash);
    }
    // Preserve append-only audit access for the runtime role on every migration run.
    await client.query(
      readFileSync(new URL("./audit-runtime-privileges.sql", import.meta.url), "utf8"),
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const shouldReset = args.has("--reset");
  if (shouldReset && process.env.NODE_ENV === "production" && !args.has("--force")) {
    throw new Error("Refusing --reset when NODE_ENV=production without --force");
  }
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
  try {
    if (shouldReset) {
      await resetDatabaseSchema(client);
      console.log("PostgreSQL schema reset complete");
    }
    await migrateByHash(client, "./drizzle");
  } finally {
    client.release();
  }
  console.log("PostgreSQL migrations applied successfully");
  await pool.end();
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (e) => {
    console.error(e);
    const { pool } = await import("../src/db");
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
