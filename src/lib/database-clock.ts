import { db } from "../db";
import { sql } from "drizzle-orm";

/**
 * Gateway database wall clock in epoch milliseconds.
 *
 * All print-job expiry/lease comparisons are evaluated by PostgreSQL, so
 * lifecycle grace windows must use the same clock instead of the Node host's
 * wall clock. The database is the single time authority for Gateway jobs.
 */
export async function databaseNowMs(): Promise<number> {
  const result = await db.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
  const raw = (result.rows[0] as { now_ms?: number | string } | undefined)?.now_ms;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error("Database clock is unavailable");
  }
  return value;
}
