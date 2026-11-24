import { db, type DbTx } from "../db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { credentialVersionFor, sameCredentialVersion } from "./session-credentials";

export const PLATFORM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const PLATFORM_SESSION_IDLE_MS = 30 * 60 * 1000;

export class PlatformSessionExpiredError extends Error {
  constructor() { super("Your session expired or changed. Sign in again."); this.name = "PlatformSessionExpiredError"; }
}

/** Only an internal snapshot from actual password verification is accepted.
 * Keep the account lock until both policy and refresh credentials are committed. */
export async function preparePlatformSessionInTransaction(
  tx: DbTx,
  principal: { userId?: string | null; email?: string | null; credentialVersion?: string },
  familyId: string,
  nowMs: number,
): Promise<void> {
  if (!principal.userId || !principal.credentialVersion || !principal.email) throw new PlatformSessionExpiredError();
  const result = await tx.execute(sql`SELECT password_hash,email,is_platform_owner,email_verified_at FROM users WHERE id=${principal.userId} FOR UPDATE`);
  const user = result.rows[0] as { password_hash: string; email: string; is_platform_owner: boolean; email_verified_at: unknown } | undefined;
  if (!user?.email_verified_at || !user.is_platform_owner || user.email !== principal.email ||
      !sameCredentialVersion(principal.credentialVersion, credentialVersionFor(principal.userId, user.password_hash))) throw new PlatformSessionExpiredError();
  // A one-way fingerprint of the existing salted verifier. It is neither a
  // password nor an authentication credential, and never enters API responses.
  const passwordVersion = createHash("sha256").update(user.password_hash, "utf8").digest("hex");
  await tx.execute(sql`INSERT INTO platform_session_security
    (family_id,user_id,password_version,password_verified_at,last_seen_at,expires_at)
    VALUES (${familyId},${principal.userId},${passwordVersion},${new Date(nowMs)},${new Date(nowMs)},${new Date(nowMs+PLATFORM_SESSION_TTL_MS)})`);
}

/** Background refresh/probe checks never extend activity. */
export async function isPlatformSessionAssured(
  familyId: string, userId: string, touch = false, connection: Pick<DbTx, "execute"> = db,
): Promise<boolean> {
  const conditions = sql`
    s.family_id=${familyId} AND s.user_id=${userId}
    AND u.id=s.user_id AND u.is_platform_owner=true AND u.email_verified_at IS NOT NULL
    AND s.password_version=encode(sha256(convert_to(u.password_hash,'UTF8')),'hex') AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()
    AND s.last_seen_at>clock_timestamp()-interval '30 minutes' AND s.last_seen_at<=clock_timestamp()
    AND s.password_verified_at<=clock_timestamp()
  `;
  const result = touch
    ? await connection.execute(sql`UPDATE platform_session_security s SET last_seen_at=clock_timestamp() FROM users u WHERE ${conditions} RETURNING s.family_id`)
    : await connection.execute(sql`SELECT s.family_id FROM platform_session_security s,users u WHERE ${conditions}`);
  return result.rows.length === 1;
}

