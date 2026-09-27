import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { getWorkerSchema, schemaSearchPath } from "../lib/worker-schema";
import { runtimeSecret } from "../lib/runtime-secret";
import { logError } from "../lib/log";

const databaseUrl = runtimeSecret("DATABASE_URL");
const pgPassword = runtimeSecret("PGPASSWORD");

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaWorkerSchema?: string | null;
};

function parsePgPort(): number {
  const raw = (process.env.PGPORT ?? "5432").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Refusing startup: PGPORT must be an integer 1..65535 (got ${JSON.stringify(process.env.PGPORT)}).`);
  }
  const port = parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing startup: PGPORT must be an integer 1..65535 (got ${JSON.stringify(process.env.PGPORT)}).`);
  }
  return port;
}

function createPool(): Pool {
  const hasStructuredConfig = Boolean(
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER ||
    pgPassword,
  );

  if (!databaseUrl && !hasStructuredConfig) {
    const dummy = {
      query: async () => { throw new Error("PostgreSQL connection settings are required at runtime"); },
      connect: async () => { throw new Error("PostgreSQL connection settings are required at runtime"); },
      on: () => dummy,
      end: async () => {},
    } as unknown as Pool;
    return dummy;
  }

  const workerSchema = getWorkerSchema();
  if (workerSchema && globalForDb.__arenaWorkerSchema === undefined) {
    globalForDb.__arenaWorkerSchema = workerSchema;
  }
  const searchPath = workerSchema ? schemaSearchPath(workerSchema) : null;

  const poolConfig: PoolConfig = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: process.env.PGHOST,
        port: parsePgPort(),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: pgPassword,
      };

  // Pin the session timezone to UTC: the schema stores naive timestamps
  // and every lease/TTL/sweep compares SQL now() against app-written times.
  // Against a cloud database running a non-UTC zone, an unpinned session
  // would silently shift all thresholds by the UTC offset.
  const sessionOptions = ["-c timezone=UTC"];
  if (searchPath) {
    sessionOptions.push(`-c search_path=${searchPath}`);
  }
  poolConfig.options = sessionOptions.join(" ");

  poolConfig.max = 20;
  poolConfig.idleTimeoutMillis = 30_000;
  poolConfig.connectionTimeoutMillis = 10_000;
  poolConfig.statement_timeout = 30_000;
  poolConfig.lock_timeout = 5_000;
  poolConfig.maxUses = 10_000;

  return new Pool(poolConfig);
}

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createPool();

// Idle-client errors (e.g. DB bounce, network reset) rethrow from the Pool
// and crash Node when no 'error' listener is attached. Contain them as
// observable log lines; in-flight queries still fail individually and the
// pool replaces the dead client.
if (typeof (pool as unknown as { on?: unknown }).on === "function") {
  pool.on("error", (error: Error) => {
    logError("pg.pool_idle_client_error", { error: error instanceof Error ? error.message : String(error) });
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

import * as schema from "./schema";
export const db = drizzle(pool, { schema });

/** Canonical transaction type for all lib modules (single definition). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
