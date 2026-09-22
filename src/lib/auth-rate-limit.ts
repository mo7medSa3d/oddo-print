import { db } from "../db";
import { sql } from "drizzle-orm";
import { isIP } from "node:net";

/**
 * Database-backed authentication rate limiter.
 *
 * Designed for the supported multi-instance deployment: every gateway process
 * shares PostgreSQL, so an in-memory limiter would be bypassed by spraying
 * attempts across instances. State lives in `auth_rate_limits`.
 *
 * Keys:
 *   ip:<client-ip>              — per source address when a trusted proxy is configured
 *   acct:<username>             — per login identifier (lowercased, trimmed)
 *   pairing-ip:<client-ip>      — dedicated pairing endpoint budget, independent of code value
 *
 * When TRUST_PROXY is not explicitly enabled, the framework Request does not
 * expose a trustworthy TCP peer address. We therefore use account-scoped
 * limiting for manager login; pairing falls back to one shared bucket until a
 * trusted proxy is configured, preventing code rotation from bypassing limits.
 */

export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
export const PAIRING_RATE_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_RATE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Raw `db.execute()` rows surface naive UTC timestamp strings while typed
 * drizzle rows surface Date; normalize either to epoch ms without host-TZ skew.
 */
function parseDbTimeMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const text = value.trim();
  if (!text) return null;
  let iso = text.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

let warnedUntrustedProxy = false;

function trustProxyEnabled(): boolean {
  return process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
}

function warnUntrustedProxyOnce(): void {
  if (warnedUntrustedProxy || process.env.NODE_ENV !== "production") return;
  warnedUntrustedProxy = true;
  console.warn(
    "[auth-rate-limit] TRUST_PROXY is not enabled in production; IP-scoped auth rate limiting is disabled. " +
    "Set TRUST_PROXY only when the deployment is behind a trusted proxy that sanitizes forwarding headers."
  );
}

export function lockDurationMs(failures: number): number {
  if (failures < 5) return 0;
  if (failures < 10) return 30_000;
  if (failures < 15) return 5 * 60_000;
  if (failures < 20) return 15 * 60_000;
  return 60 * 60_000;
}

export function pairingLockDurationMs(failures: number): number {
  // Pairing keeps the requested six-digit UX. The progressively stronger
  // lockout prevents rotating through different six-digit values from
  // becoming an online brute-force oracle.
  if (failures < 5) return 0;
  if (failures < 10) return 30_000;
  if (failures < 15) return 5 * 60_000;
  if (failures < 20) return 15 * 60_000;
  return 60 * 60_000;
}

export function clientIpFrom(req: Request): string {
  if (!trustProxyEnabled()) {
    warnUntrustedProxyOnce();
    return "unknown";
  }

  const candidates = [
    ...(req.headers.get("x-forwarded-for")?.split(",") ?? []),
    req.headers.get("x-real-ip") ?? "",
  ];
  for (const candidate of candidates) {
    const ip = candidate.trim();
    if (ip && isIP(ip) !== 0) return ip.slice(0, 128);
  }
  return "unknown";
}

export function accountKey(username: string): string {
  return `acct:${username.trim().toLowerCase().slice(0, 128)}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip.slice(0, 128)}`;
}

function pairingIpKey(ip: string): string {
  return `pairing-ip:${ip.slice(0, 128)}`;
}

export type RateLimitDecision =
  | { allowed: true; retryAfterSec?: number }
  | { allowed: false; retryAfterSec: number };

async function reserveBucketAttempt(
  key: string,
  windowMs: number,
  lockFn: (attempts: number) => number,
): Promise<RateLimitDecision> {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
      VALUES (${key}, 0, ${now}, NULL, ${now})
      ON CONFLICT (key) DO NOTHING
    `);
    const current = await tx.execute(sql`
      SELECT failures, window_started_at, locked_until
      FROM auth_rate_limits
      WHERE key = ${key}
      FOR UPDATE
    `);
    const row = (current.rows[0] as {
      failures?: number | string;
      window_started_at?: Date | string;
      locked_until?: Date | string | null;
    } | undefined) ?? { failures: 0, window_started_at: now, locked_until: null };

    const existingLockMs = parseDbTimeMs(row.locked_until);
    if (existingLockMs !== null && existingLockMs > now.getTime()) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((existingLockMs - now.getTime()) / 1000)) };
    }

    const oldWindowMs = parseDbTimeMs(row.window_started_at ?? now) ?? now.getTime();
    const windowExpired = oldWindowMs < windowStartCutoff.getTime();
    const attempts = windowExpired ? 1 : Number(row.failures ?? 0) + 1;
    const newWindowStart = windowExpired ? now : new Date(oldWindowMs);
    const lockMs = lockFn(attempts);
    const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs) : null;

    await tx.execute(sql`
      UPDATE auth_rate_limits
      SET failures = ${attempts},
          window_started_at = ${newWindowStart},
          locked_until = ${lockedUntil},
          updated_at = ${now}
      WHERE key = ${key}
    `);

    return lockedUntil
      ? { allowed: true, retryAfterSec: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)) }
      : { allowed: true };
  });
}

export async function reservePairingAttempt(ip: string): Promise<RateLimitDecision> {
  return reserveBucketAttempt(pairingIpKey(ip), PAIRING_RATE_WINDOW_MS, pairingLockDurationMs);
}

export async function reserveAuthAttempt(ip: string, username: string): Promise<RateLimitDecision> {
  const keys = [accountKey(username)];
  if (trustProxyEnabled() && ip !== "unknown") keys.push(ipKey(ip));
  keys.sort();

  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - AUTH_RATE_WINDOW_MS);
  return db.transaction(async (tx) => {
    for (const key of keys) {
      await tx.execute(sql`
        INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
        VALUES (${key}, 0, ${now}, NULL, ${now})
        ON CONFLICT (key) DO NOTHING
      `);
    }

    const rows = await tx.execute(sql`
      SELECT key, failures, window_started_at, locked_until
      FROM auth_rate_limits
      WHERE key IN (${sql.join(keys.map((key) => sql`${key}`), sql`, `)})
      ORDER BY key
      FOR UPDATE
    `);

    for (const raw of rows.rows as Array<{ failures?: number | string; window_started_at?: Date | string; locked_until?: Date | string | null }>) {
      const lockedUntilMs = parseDbTimeMs(raw.locked_until);
      if (lockedUntilMs !== null && lockedUntilMs > now.getTime()) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((lockedUntilMs - now.getTime()) / 1000)) };
      }
    }

    const exhaustedLocks: number[] = [];
    for (const raw of rows.rows as Array<{ key: string; failures?: number | string; window_started_at?: Date | string }>) {
      const oldWindowMs = parseDbTimeMs(raw.window_started_at ?? now) ?? now.getTime();
      const windowExpired = oldWindowMs < windowStartCutoff.getTime();
      const attempts = windowExpired ? 1 : Number(raw.failures ?? 0) + 1;
      const newWindowStart = windowExpired ? now : new Date(oldWindowMs);
      const lockMs = lockDurationMs(attempts);
      const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs) : null;
      if (lockedUntil) exhaustedLocks.push(lockedUntil.getTime());
      await tx.execute(sql`
        UPDATE auth_rate_limits
        SET failures = ${attempts},
            window_started_at = ${newWindowStart},
            locked_until = ${lockedUntil},
            updated_at = ${now}
        WHERE key = ${raw.key}
      `);
    }
    return exhaustedLocks.length > 0
      ? { allowed: true, retryAfterSec: Math.max(1, Math.ceil((Math.max(...exhaustedLocks) - now.getTime()) / 1000)) }
      : { allowed: true };
  });
}

export async function cleanupAuthRateLimits(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTH_RATE_RETENTION_MS);
  const result = await db.execute(sql`
    DELETE FROM auth_rate_limits
    WHERE updated_at < ${cutoff}
    RETURNING key
  `);
  return result.rows.length;
}

export async function recordAuthSuccess(ip: string, username: string): Promise<void> {
  const keys = [accountKey(username)];
  if (trustProxyEnabled() && ip !== "unknown") keys.push(ipKey(ip));
  await db.execute(sql`
    DELETE FROM auth_rate_limits
    WHERE key IN (${sql.join(keys.map((key) => sql`${key}`), sql`, `)})
  `);
}

export async function recordPairingSuccess(ip: string): Promise<void> {
  await db.execute(sql`DELETE FROM auth_rate_limits WHERE key = ${pairingIpKey(ip)}`);
}
