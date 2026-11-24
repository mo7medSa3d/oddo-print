import { db } from "../db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { trustProxyEnabled } from "./trust-proxy-config";
import { logError } from "./log";
import { parseDbTimeMs } from "./database-clock";

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
 *   acct:<scope>:<sha256>       — per unauthenticated workflow (forgot-password,
 *                                 register, resend-verification). These endpoints
 *                                 accept no password proof, so they must never
 *                                 spend the login bucket: sharing it lets anonymous
 *                                 requests lock a victim out of sign-in.
 *   pairing-ip:<client-ip>      — dedicated pairing endpoint budget, independent of code value
 *   pairing-code:<sha256>       — per-code velocity fence: distributed guessing
 *                                 of one code shares a bucket and locks fast
 *
 * When TRUST_PROXY is not explicitly enabled, the framework Request does not
 * expose a trustworthy TCP peer address. IP-scoped buckets are skipped for
 * unknown addresses (no shared global lockout); pairing relies on the
 * per-code fence instead, so code rotation cannot bypass limits either.
 */

const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

let warnedUntrustedProxy = false;

function warnUntrustedProxyOnce(): void {
  if (warnedUntrustedProxy || process.env.NODE_ENV !== "production") return;
  warnedUntrustedProxy = true;
  logError("auth.rate_limit.untrusted_proxy", {
    message: "TRUST_PROXY is not enabled in production; IP-scoped auth rate limiting is disabled and only per-account/per-code fences remain. Set TRUST_PROXY=1 only behind a trusted proxy that sanitizes forwarding headers (see server.ts startup checks).",
  });
}

const ACCOUNT_LOCK_THRESHOLDS = [5, 10, 15, 20] as const;
const IP_LOCK_THRESHOLDS = [20, 30, 40, 50] as const;
const LOCK_DURATIONS_MS = [0, 30_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

type RateLimitCurve = "account" | "ip";

function thresholdsFor(curve: RateLimitCurve): readonly number[] {
  return curve === "ip" ? IP_LOCK_THRESHOLDS : ACCOUNT_LOCK_THRESHOLDS;
}

function lockDurationFor(curve: RateLimitCurve, failures: number): number {
  const thresholds = thresholdsFor(curve);
  for (let index = 0; index < thresholds.length; index += 1) {
    if (failures < thresholds[index]!) return LOCK_DURATIONS_MS[index]!;
  }
  return LOCK_DURATIONS_MS[LOCK_DURATIONS_MS.length - 1]!;
}

function activeLimitFor(failures: number, curve: RateLimitCurve): number {
  const thresholds = thresholdsFor(curve);
  return thresholds.find((threshold) => failures <= threshold) ?? thresholds[thresholds.length - 1]!;
}

export function lockDurationMs(failures: number): number {
  return lockDurationFor("account", failures);
}

export function ipLockDurationMs(failures: number): number {
  return lockDurationFor("ip", failures);
}

export function clientIpFrom(req: Request): string {
  if (!trustProxyEnabled()) {
    warnUntrustedProxyOnce();
    return "unknown";
  }

  // The edge proxy overwrites X-Forwarded-For with the actual client
  // address (see Caddyfile), but a chained or misconfigured path may still
  // carry a list. Take the LAST valid entry (closest to the trusted proxy):
  // attacker-controlled leftmost values must never select the bucket.
  const candidates = [
    ...(req.headers.get("x-forwarded-for")?.split(",") ?? []),
    req.headers.get("x-real-ip") ?? "",
  ];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const ip = candidates[i]!.trim();
    if (ip && isIP(ip) !== 0) return ip.slice(0, 128);
  }
  return "unknown";
}

export function accountKey(username: string): string {
  const normalized = username.trim().toLowerCase();
  // v3: truncation alone is not an identity. Two distinct addresses sharing
  // a 128-char prefix previously shared one bucket; long identities now get
  // a SHA-256 key so every distinct identity gets a distinct bucket. Short
  // identities keep the legacy readable form (rate-limit rows are ephemeral,
  // cleaned after 24h, so the format change needs no migration).
  if (normalized.length > 128) {
    return `acct:sha256:${createHash("sha256").update(normalized).digest("hex")}`;
  }
  return `acct:${normalized}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip.slice(0, 128)}`;
}

function scopedIpKey(scope: string, ip: string): string {
  // v3: scoped workflows get their own IP bucket. Previously the scoped
  // account bucket was isolated but reserveAuthAttempt appended the plain
  // `ip:` bucket, so anonymous forgot-password/register/resend traffic could
  // lock login for every user behind the same NAT address (and vice versa).
  // The `ip:` prefix is kept so the IP lock curve still applies.
  return `ip:${scope}:${ip.slice(0, 128)}`;
}

type RateLimitBucketSnapshot = {
  limit: number;
  remaining: number;
  resetAtMs: number;
  lockedUntilMs: number | null;
};

type RateLimitDecision = {
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

/**
 * Rate-limit budget for an unauthenticated account workflow, isolated from
 * the login bucket. The per-endpoint curve and lock schedule are unchanged
 * (reserveAuthAttempt still applies them); only the account namespace differs,
 * keyed by a SHA-256 of the normalized address so long addresses cannot
 * collide under accountKey's 128-character truncation. Callers must never
 * pair this with recordAuthSuccess: these workflows are not authentication
 * events, and clearing on completion would let a caller bypass the budget.
 */
export async function reserveScopedAuthAttempt(
  ip: string,
  scope: "forgot-password" | "register" | "resend-verification",
  username: string,
): Promise<RateLimitDecision> {
  const digest = createHash("sha256").update(username.trim().toLowerCase()).digest("hex");
  // v3: pass the scope through so the IP bucket is scoped too. Previously
  // this delegated to the plain login IP bucket (see scopedIpKey).
  return reserveAuthAttempt(ip, `${scope}:${digest}`, scope);
}

export async function reserveAuthAttempt(ip: string, username: string, ipScope?: string): Promise<RateLimitDecision> {
  const keys = [accountKey(username)];
  // Unknown source addresses must not share one global lockout bucket. Valid
  // trusted-proxy addresses retain the wider NAT-tolerant spray protection.
  // Scoped callers use a scope-prefixed IP bucket, never the login IP bucket.
  if (isIP(ip) !== 0) keys.push(ipScope ? scopedIpKey(ipScope, ip) : ipKey(ip));
  keys.sort();

  return db.transaction(async (tx) => {
    for (const key of keys) {
      await tx.execute(sql`
        INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
        VALUES (${key}, 0, clock_timestamp(), NULL, clock_timestamp())
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
    const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
    const nowMs = Number(clock.rows[0]?.now_ms);
    if (!Number.isFinite(nowMs)) throw new Error("Database clock is unavailable");
    const now = new Date(nowMs);
    const windowStartCutoff = new Date(now.getTime() - AUTH_RATE_WINDOW_MS);

    for (const raw of rows.rows as Array<{ key: string; failures?: number | string; window_started_at?: Date | string; locked_until?: Date | string | null }>) {
      const lockedUntilMs = parseDbTimeMs(raw.locked_until);
      if (lockedUntilMs !== null && lockedUntilMs > now.getTime()) {
        const snapshots = rows.rows.map((candidate) => {
          const rowCandidate = candidate as { key: string; failures?: number | string; window_started_at?: Date | string; locked_until?: Date | string | null };
          return snapshotBucket(
            Number(rowCandidate.failures ?? 0),
            parseDbTimeMs(rowCandidate.window_started_at ?? now) ?? now.getTime(),
            parseDbTimeMs(rowCandidate.locked_until),
            now.getTime(),
            AUTH_RATE_WINDOW_MS,
            rowCandidate.key.startsWith("ip:") ? "ip" : "account",
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
  const parsedLimit = Number(process.env.MAINTENANCE_SWEEP_LIMIT);
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1
    ? Math.min(Math.floor(parsedLimit), 5000)
    : 500;
  // Production cleanup uses PostgreSQL's wall clock because the retained
  // security state is persisted in the same database as the reservation logic.
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT key
      FROM auth_rate_limits
      WHERE updated_at < clock_timestamp() - interval '24 hours'
      ORDER BY updated_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM auth_rate_limits
    USING candidates
    WHERE auth_rate_limits.key = candidates.key
    RETURNING auth_rate_limits.key
  `);
  return result.rows.length;
}

/**
 * v3: refund exactly one reservation for a token endpoint (reset-password /
 * verify-email) whose limiter identity is a *shared* bucket. Those routes
 * scope by endpoint + IP when the client is known, so the "account" key is
 * really a shared source bucket: fully clearing it on one valid token would
 * erase every other guesser's accumulated budget from that NAT address.
 * This refunds one reservation from each key and never touches locked_until,
 * so an accumulated lock survives a single success. Login routes must NOT
 * use this: the account owner proved possession there, so recordAuthSuccess
 * (full account clear) remains correct for them.
 */
export async function refundAuthReservation(ip: string, username: string, ipScope?: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE auth_rate_limits SET failures = GREATEST(failures - 1, 0)
      WHERE key = ${accountKey(username)}
    `);
    if (isIP(ip) !== 0) {
      // B2: callers that reserved with a scoped IP bucket must refund that
      // same bucket. Refunding the plain login IP bucket here would erode
      // unrelated login guessers' budget from the same source address.
      const bucket = ipScope ? scopedIpKey(ipScope, ip) : ipKey(ip);
      await tx.execute(sql`
        UPDATE auth_rate_limits SET failures = GREATEST(failures - 1, 0)
        WHERE key = ${bucket}
      `);
    }
  });
}


export async function recordAuthSuccess(ip: string, username: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Login only: the account owner just proved possession, so clearing the
    // owner's own account bucket (including a lock this attempt triggered)
    // is correct. The IP bucket is only refunded by one, because other
    // guesses from the same source may not be benign. Token endpoints with
    // a shared bucket must use refundAuthReservation instead.
    await tx.execute(sql`DELETE FROM auth_rate_limits WHERE key = ${accountKey(username)}`);
    if (isIP(ip) !== 0) {
      await tx.execute(sql`
        UPDATE auth_rate_limits SET failures = GREATEST(failures - 1, 0)
        WHERE key = ${ipKey(ip)}
      `);
    }
  });
}

