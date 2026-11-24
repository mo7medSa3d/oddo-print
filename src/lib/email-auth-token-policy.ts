import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Mailbox verification, password recovery and setup proofs share this cap.
 * Stamp issuance after any earlier transaction lock wait, using database time.
 * Existing rows keep their original issuance time and any shorter deadline. */
export function emailAuthTokenTimes() {
  return {
    createdAt: sql`clock_timestamp()`,
    expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
  };
}

/** Apply at preflight and again at atomic consumption. The creation-time cap
 * also fences outstanding tokens issued under the previous 20/30-minute
 * policy. Neither application-clock skew nor a lock wait can extend proof. */
export function emailAuthTokenIsLive(table: { createdAt: AnyPgColumn; expiresAt: AnyPgColumn }): SQL {
  return sql`(${table.createdAt} <= clock_timestamp()
    AND ${table.createdAt} > clock_timestamp() - interval '10 minutes'
    AND ${table.expiresAt} > clock_timestamp())`;
}
