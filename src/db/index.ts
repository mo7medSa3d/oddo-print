import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, defaults, type PoolConfig } from "pg";
import { getWorkerSchema, schemaSearchPath } from "../lib/worker-schema";
import { runtimeSecret } from "../lib/runtime-secret";
import { logError } from "../lib/log";

// Raw SQL Date parameters must match the schema's UTC-naive timestamp storage.
defaults.parseInputDatesAsUTC = true;

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

// node-postgres ignores PGSSLMODE/PGSSLROOTCERT when given structured config
// (host/port/user/database) instead of a connectionString. Translate them
// explicitly so production deployments using PG* + secret files can enforce TLS.
function parsePgSsl(): PoolConfig["ssl"] {
  const mode = process.env.PGSSLMODE?.trim().toLowerCase();
  if (!mode || mode === "disable") return undefined;
  if (mode === "require" || mode === "verify-ca" || mode === "verify-full") {
    const rootCertPath = process.env.PGSSLROOTCERT?.trim();
    return rootCertPath
      ? { rejectUnauthorized: true, ca: readFileSync(rootCertPath, "utf8") }
      : { rejectUnauthorized: true };
  }
  throw new Error(
    `Refusing startup: PGSSLMODE must be one of disable, require, verify-ca, verify-full (got ${JSON.stringify(process.env.PGSSLMODE)}).`,
  );
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

  const ssl = databaseUrl ? undefined : parsePgSsl();
  const poolConfig: PoolConfig = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: process.env.PGHOST,
        port: parsePgPort(),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: pgPassword,
        ...(ssl !== undefined ? { ssl } : {}),
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

  poolConfig.application_name = process.env.PGAPPNAME?.trim() || "yaseir-gateway";
  poolConfig.max = 20;
  poolConfig.idleTimeoutMillis = 30_000;
  poolConfig.connectionTimeoutMillis = 10_000;
  poolConfig.statement_timeout = 30_000;
  // Client-side query deadline (5s above statement_timeout) and TCP keepalives
  // reap half-open/blackholed sockets that server timeouts cannot reach.
  poolConfig.query_timeout = 35_000;
  poolConfig.keepAlive = true;
  poolConfig.keepAliveInitialDelayMillis = 10_000;
  poolConfig.lock_timeout = 5_000;
  // A statement deadline does not cover time spent waiting in application
  // code after BEGIN. Reap stalled transactions so their row/advisory locks
  // and pool slot cannot survive indefinitely when a request is interrupted.
  poolConfig.idle_in_transaction_session_timeout = 30_000;
  poolConfig.maxUses = 10_000;

  const configuredPool = new Pool(poolConfig);
  // Idle-client errors (e.g. DB bounce, network reset) rethrow from the Pool
  // and crash Node when no 'error' listener is attached. Attach once here at
  // pool creation so HMR reloads reusing globalForDb do not leak listeners.
  configuredPool.on("error", (error: Error) => {
    logError("pg.pool_idle_client_error", {
      error: error instanceof Error ? error.message : String(error),
      totalCount: configuredPool.totalCount,
      idleCount: configuredPool.idleCount,
      waitingCount: configuredPool.waitingCount,
    });
  });
  // The Pool's own error event only covers idle clients. A server-side idle
  // transaction deadline (or a DB restart) can also close a checked-out client
  // while application code is awaiting something other than a query. Keep a
  // listener for that client's lifetime so the EventEmitter does not crash
  // the process; the transaction's next query still rejects normally. Attach
  // once at connection creation, never per checkout (which would retain one
  // listener on every reuse of the same client).
  configuredPool.on("connect", (client) => {
    client.on("error", (error: Error) => {
      logError("pg.client_connection_error", {
        error: error instanceof Error ? error.message : String(error),
        totalCount: configuredPool.totalCount,
        idleCount: configuredPool.idleCount,
        waitingCount: configuredPool.waitingCount,
      });
    });
  });
  return configuredPool;
}

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createPool();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

import * as schema from "./schema";
export const db = drizzle(pool, { schema });

/** Canonical transaction type for all lib modules (single definition). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
