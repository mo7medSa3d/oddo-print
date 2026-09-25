import { db } from "../db";
import { sql } from "drizzle-orm";
import { isIP } from "node:net";
import { trustProxyEnabled } from "./trust-proxy-config";

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

function warnUntrustedProxyOnce(): void {
  if (warnedUntrustedProxy || process.env.NODE_ENV !== "production") return;
  warnedUntrustedProxy = true;
  console.warn(
    "[auth-rate-limit] TRUST_PROXY is not enabled in production; IP-scoped auth rate limiting is disabled. " +
    "Set TRUST_PROXY only when the deployment is behind a trusted proxy that sanitizes forwarding headers."
  );
}

const ACCOUNT_LOCK_THRESHOLDS = [5, 10, 15, 20] as const;
const IP_LOCK_THRESHOLDS = [20, 30, 40, 50] as const;

type RateLimitCurve = "account" | "ip";

function progressiveLockDurationMs(failures: number): number {
  if (failures < 5) return 0;
  if (failures < 10) return 30_000;
  if (failures < 15) return 5 * 60_000;
  if (failures < 20) return 15 * 60_000;
  return 60 * 60_000;
}

function progressiveIpLockDurationMs(failures: number): number {
  if (failures < 20) return 0;
  if (failures < 30) return 30_000;
  if (failures < 40) return 5 * 60_000;
  if (failures < 50) return 15 * 60_000;
  return 60 * 60_000;
}

function thresholdsFor(curve: RateLimitCurve): readonly number[] {
  return curve === "ip" ? IP_LOCK_THRESHOLDS : ACCOUNT_LOCK_THRESHOLDS;
}

function lockDurationFor(curve: RateLimitCurve, failures: number): number {
  return curve === "ip" ? progressiveIpLockDurationMs(failures) : progressiveLockDurationMs(failures);
}

function activeLimitFor(failures: number, curve: RateLimitCurve): number {
  const thresholds = thresholdsFor(curve);
  return thresholds.find((threshold) => failures <= threshold) ?? thresholds[thresholds.length - 1]!;
}

export function lockDurationMs(failures: number): number {
  return progressiveLockDurationMs(failures);
}

export function ipLockDurationMs(failures: number): number {
  return progressiveIpLockDurationMs(failures);
}

export function pairingLockDurationMs(failures: number): number {
  // Pairing keeps its existing authoritative progressive lockout schedule.
  return progressiveLockDurationMs(failures);
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

type RateLimitBucketSnapshot = {
  limit: number;
  remaining: number;
  resetAtMs: number;
  lockedUntilMs: number | null;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSec?: number;
  limit: number;
  remaining: number;
  resetAtEpochSec: number;
};

function snapshotBucket(
  failures: number,
  windowStartMs: number,
  lockedUntilMs: number | null,
  nowMs: number,
  windowMs: number,
  curve: RateLimitCurve,
): RateLimitBucketSnapshot {
  const activeLock = lockedUntilMs !== null && lockedUntilMs > nowMs;
  const limit = activeLimitFor(failures, curve);
  return {
    limit,
    remaining: activeLock ? 0 : Math.max(0, limit - failures),
    resetAtMs: activeLock ? lockedUntilMs : windowStartMs + windowMs,
    lockedUntilMs: activeLock ? lockedUntilMs : null,
  };
}

function effectiveSnapshot(snapshots: RateLimitBucketSnapshot[]): RateLimitBucketSnapshot {
  return snapshots.reduce((best, current) => {
    const bestRatio = best.limit > 0 ? best.remaining / best.limit : 0;
    const currentRatio = current.limit > 0 ? current.remaining / current.limit : 0;
    return currentRatio < bestRatio ? current : best;
  });
}

function blockedDecision(snapshots: RateLimitBucketSnapshot[], nowMs: number): RateLimitDecision {
  const locked = snapshots.filter((snapshot) => snapshot.lockedUntilMs !== null);
  const latestLockMs = Math.max(...locked.map((snapshot) => snapshot.lockedUntilMs as number));
  const limiting = locked.find((snapshot) => snapshot.resetAtMs === latestLockMs) ?? locked[0]!;
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((latestLockMs - nowMs) / 1000)),
    limit: limiting.limit,
    remaining: 0,
    resetAtEpochSec: Math.ceil(latestLockMs / 1000),
  };
}

function allowedDecision(snapshots: RateLimitBucketSnapshot[], nowMs: number): RateLimitDecision {
  const locked = snapshots.filter((snapshot) => snapshot.lockedUntilMs !== null);
  if (locked.length > 0) {
    const latestLockMs = Math.max(...locked.map((snapshot) => snapshot.lockedUntilMs as number));
    const limiting = locked.find((snapshot) => snapshot.resetAtMs === latestLockMs) ?? locked[0]!;
    return {
      allowed: true,
      retryAfterSec: Math.max(1, Math.ceil((latestLockMs - nowMs) / 1000)),
      limit: limiting.limit,
      remaining: 0,
      resetAtEpochSec: Math.ceil(latestLockMs / 1000),
    };
  }
  const snapshot = effectiveSnapshot(snapshots);
  return {
    allowed: true,
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    resetAtEpochSec: Math.ceil(snapshot.resetAtMs / 1000),
  };
}

export function setRateLimitHeaders<T extends Response>(response: T, decision: RateLimitDecision): T {
  response.headers.set("X-RateLimit-Limit", String(decision.limit));
  response.headers.set("X-RateLimit-Remaining", String(decision.remaining));
  response.headers.set("X-RateLimit-Reset", String(decision.resetAtEpochSec));
  return response;
}

async function reserveBucketAttempt(
  key: string,
  windowMs: number,
  lockFn: (attempts: number) => number,
  curve: RateLimitCurve = "account",
): Promise<RateLimitDecision> {
  return db.transaction(async (tx) => {
    const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
    const nowMs = Number(clock.rows[0]?.now_ms);
    if (!Number.isFinite(nowMs)) throw new Error("Database clock is unavailable");
    const now = new Date(nowMs);
    const windowStartCutoff = new Date(now.getTime() - windowMs);
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
      const snapshot = snapshotBucket(
        Number(row.failures ?? 0),
        parseDbTimeMs(row.window_started_at ?? now) ?? now.getTime(),
        existingLockMs,
        now.getTime(),
        windowMs,
        curve,
      );
      return blockedDecision([snapshot], now.getTime());
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

    return allowedDecision([
      snapshotBucket(
        attempts,
        newWindowStart.getTime(),
        lockedUntil?.getTime() ?? null,
        now.getTime(),
        windowMs,
        curve,
      ),
    ], now.getTime());
  });
}

export async function reservePairingAttempt(ip: string): Promise<RateLimitDecision> {
  return reserveBucketAttempt(pairingIpKey(ip), PAIRING_RATE_WINDOW_MS, pairingLockDurationMs, "account");
}

export async function reserveAuthAttempt(ip: string, username: string): Promise<RateLimitDecision> {
  const keys = [accountKey(username)];
  if (trustProxyEnabled() && ip !== "unknown") keys.push(ipKey(ip));
  keys.sort();

  return db.transaction(async (tx) => {
    const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
    const nowMs = Number(clock.rows[0]?.now_ms);
    if (!Number.isFinite(nowMs)) throw new Error("Database clock is unavailable");
    const now = new Date(nowMs);
    const windowStartCutoff = new Date(now.getTime() - AUTH_RATE_WINDOW_MS);
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

    for (const raw of rows.rows as Array<{ key: string; failures?: number | string; window_started_at?: Date | string; locked_until?: Date | string | null }>) {
      const lockedUntilMs = parseDbTimeMs(raw.locked_until);
      if (lockedUntilMs !== null && lockedUntilMs > now.getTime()) {
        const snapshots = rows.rows.map((candidate) => {
          const rowCandidate = candidate as { key: string; failures?: number | string; window_started_at?: Date | string; locked_until?: Date | string | null };
          const curve: RateLimitCurve = rowCandidate.key.startsWith("ip:") ? "ip" : "account";
          return snapshotBucket(
            Number(rowCandidate.failures ?? 0),
            parseDbTimeMs(rowCandidate.window_started_at ?? now) ?? now.getTime(),
            parseDbTimeMs(rowCandidate.locked_until),
            now.getTime(),
            AUTH_RATE_WINDOW_MS,
            curve,
          );
        }).filter((snapshot) => snapshot.lockedUntilMs !== null);
        return blockedDecision(snapshots, now.getTime());
      }
    }

    const snapshots: RateLimitBucketSnapshot[] = [];
    for (const raw of rows.rows as Array<{ key: string; failures?: number | string; window_started_at?: Date | string }>) {
      const oldWindowMs = parseDbTimeMs(raw.window_started_at ?? now) ?? now.getTime();
      const windowExpired = oldWindowMs < windowStartCutoff.getTime();
      const attempts = windowExpired ? 1 : Number(raw.failures ?? 0) + 1;
      const newWindowStart = windowExpired ? now : new Date(oldWindowMs);
      const curve: RateLimitCurve = raw.key.startsWith("ip:") ? "ip" : "account";
      const lockMs = lockDurationFor(curve, attempts);
      const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs) : null;
      await tx.execute(sql`
        UPDATE auth_rate_limits
        SET failures = ${attempts},
            window_started_at = ${newWindowStart},
            locked_until = ${lockedUntil},
            updated_at = ${now}
        WHERE key = ${raw.key}
      `);
      snapshots.push(snapshotBucket(
        attempts,
        newWindowStart.getTime(),
        lockedUntil?.getTime() ?? null,
        now.getTime(),
        AUTH_RATE_WINDOW_MS,
        curve,
      ));
    }
    return allowedDecision(snapshots, now.getTime());
  });
}

export async function cleanupAuthRateLimits(): Promise<number> {
  // Production cleanup uses PostgreSQL's wall clock because the retained
  // security state is persisted in the same database as the reservation logic.
  const result = await db.execute(sql`
    DELETE FROM auth_rate_limits
    WHERE updated_at < clock_timestamp() - interval '24 hours'
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
