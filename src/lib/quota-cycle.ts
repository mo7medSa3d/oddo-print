import { sql, type SQL } from "drizzle-orm";

/**
 * Print credits renew at 00:00 UTC on the first of each calendar month.
 * Contract renewal/expiry is independent; only a live manual contract can admit jobs.
 * PostgreSQL owns the clock so all Gateway instances agree on the ledger key.
 */
export function quotaCycleStartSql(at: SQL = sql`statement_timestamp() AT TIME ZONE 'UTC'`): SQL {
  return sql`date_trunc('month', ${at})`;
}

export function quotaCycleEndSql(at: SQL = sql`statement_timestamp() AT TIME ZONE 'UTC'`): SQL {
  return sql`${quotaCycleStartSql(at)} + interval '1 month'`;
}
