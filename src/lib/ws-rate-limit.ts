import { db } from "../db";
import { sql } from "drizzle-orm";

const WINDOW_MS = 60_000;
const MAX_FAILURES = 20;
const LOCK_MS = 60_000;

const localLockedUntil = new Map<string, number>();

export function isWsUpgradeLocallyLocked(key: string, now = Date.now()): boolean {
  const until = localLockedUntil.get(key) ?? 0;
  if (until <= now) {
    localLockedUntil.delete(key);
    return false;
  }
  return true;
}

export async function recordWsUpgradeSuccess(key: string): Promise<void> {
  localLockedUntil.delete(key);
  await db.execute(sql`DELETE FROM auth_rate_limits WHERE key = ${`ws-upgrade:${key}`}`);
}

export async function reserveWsUpgradeAttempt(key: string): Promise<{ allowed: true; retryAfterSec?: number } | { allowed: false; retryAfterSec: number }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  return db.transaction(async (tx) => {
    const bucketKey = `ws-upgrade:${key}`;
    await tx.execute(sql`
      INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
      VALUES (${bucketKey}, 0, ${now}, NULL, ${now})
      ON CONFLICT (key) DO NOTHING
    `);
    const result = await tx.execute(sql`
      SELECT failures, window_started_at, locked_until
      FROM auth_rate_limits
      WHERE key = ${bucketKey}
      FOR UPDATE
    `);
    const row = result.rows[0] as {
      failures?: number | string;
      window_started_at?: Date | string;
      locked_until?: Date | string | null;
    } | undefined;
    if (!row) return { allowed: true } as const;

    const existingLock = row.locked_until ? new Date(row.locked_until).getTime() : 0;
    if (existingLock > now.getTime()) {
      localLockedUntil.set(key, existingLock);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((existingLock - now.getTime()) / 1000)) } as const;
    }

    const windowExpired = new Date(row.window_started_at ?? now).getTime() < cutoff.getTime();
    const failures = windowExpired ? 1 : Number(row.failures ?? 0) + 1;
    const windowStart = windowExpired ? now : new Date(row.window_started_at ?? now);
    const lockedUntil = failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MS) : null;

    await tx.execute(sql`
      UPDATE auth_rate_limits
      SET failures = ${failures},
          window_started_at = ${windowStart},
          locked_until = ${lockedUntil},
          updated_at = ${now}
      WHERE key = ${bucketKey}
    `);

    if (!lockedUntil) return { allowed: true } as const;
    const retryAfterSec = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
    localLockedUntil.set(key, lockedUntil.getTime());
    // The reservation itself is allowed; a failed authentication on this
    // attempt should return 429 and the next attempt is already blocked.
    return { allowed: true, retryAfterSec } as const;
  });
}
