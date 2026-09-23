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

/**
 * Calibrated Gateway clock.
 *
 * The database is the authority: every durable timestamp is written with
 * PostgreSQL `now()` and every SQL freshness gate compares against it. Node
 * code that evaluates the *same* facts in JS (agent/printer availability,
 * Stripe webhook tolerance, Retry-After arithmetic) must therefore not use the
 * host wall clock, which can drift from the database.
 *
 * `databaseNowMs()` measures the offset once per TTL; JS callers then read
 * `gatewayNowMs()` synchronously as `Date.now() + offset`. Until the first
 * successful calibration the offset is 0, i.e. the previous host-clock
 * behaviour, so a database outage degrades accuracy but never availability.
 */

const CLOCK_TTL_MS = 30_000;
const CLOCK_TIMEOUT_MS = 2_000;

let cachedOffsetMs: number | null = null;
/** When the last calibration *attempt* finished (success or failure). */
let lastAttemptAtHostMs = 0;
let inFlightCalibration: Promise<number | null> | null = null;

/** Last measured database-minus-host offset in milliseconds (0 when unknown). */
export function clockSkewMs(): number {
  return cachedOffsetMs ?? 0;
}

/** True when a database-calibrated offset is currently available. */
export function isClockCalibrated(): boolean {
  return cachedOffsetMs !== null;
}

/**
 * Measure (and cache) the database-minus-host clock offset.
 *
 * The host timestamp is sampled around the round trip and the midpoint is used
 * as the local reference, which removes half the round-trip latency from the
 * estimate. Returns the offset, or null when the database clock is
 * unavailable — callers keep the last known (or zero) offset in that case.
 */
export async function refreshClockSkew(force = false): Promise<number | null> {
  // A failed attempt is throttled exactly like a successful one: during a
  // database outage callers must not queue on a 2s clock probe per request.
  const fresh = Date.now() - lastAttemptAtHostMs < CLOCK_TTL_MS;
  if (!force && fresh) return cachedOffsetMs;
  if (inFlightCalibration) return inFlightCalibration;

  const calibration = (async () => {
    const startedAt = Date.now();
    let databaseMs: number;
    try {
      databaseMs = await withTimeout(databaseNowMs(), CLOCK_TIMEOUT_MS);
    } catch {
      lastAttemptAtHostMs = Date.now();
      return cachedOffsetMs;
    }
    const finishedAt = Date.now();
    const hostMidpointMs = startedAt + (finishedAt - startedAt) / 2;
    cachedOffsetMs = databaseMs - hostMidpointMs;
    lastAttemptAtHostMs = finishedAt;
    return cachedOffsetMs;
  })();

  inFlightCalibration = calibration;
  try {
    return await calibration;
  } finally {
    inFlightCalibration = null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Database clock timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Current time on the Gateway's authoritative clock, as epoch milliseconds.
 *
 * Use this for JS-side decisions that must agree with SQL `now()` comparisons —
 * never the raw host clock.
 */
export function gatewayNowMs(): number {
  return Date.now() + clockSkewMs();
}

/** `gatewayNowMs()` as a Date, for helpers whose injectable default is a Date. */
export function gatewayNow(): Date {
  return new Date(gatewayNowMs());
}

/** Test seam: set or clear the cached offset without touching the database. */
export function __setClockSkewForTests(offsetMs: number | null): void {
  if (offsetMs === null) {
    cachedOffsetMs = null;
    lastAttemptAtHostMs = 0;
    return;
  }
  cachedOffsetMs = offsetMs;
  lastAttemptAtHostMs = Date.now();
}
