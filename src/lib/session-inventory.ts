import { sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requiredRuntimeSecret } from "./runtime-secret";
import { credentialVersionFor } from "./session-credentials";
import { db, type DbTx } from "../db";
import type { ManagerClaims } from "./manager-auth";
import { requireManagerActorInTransaction } from "./manager-mutation-authorization";
import { requirePlatformActorInTransaction, validatePlatformClaims, type PlatformOwnerClaims } from "./platform-auth";
import { requireActiveTenantInTransaction } from "./tenant-guard";
import { readWorkspaceSessionState, WorkspaceSessionExpiredError } from "./workspace-session-security";
import { writeAuditEvent } from "./audit";

type SessionInventoryOwner = { scope: "platform"; claims: PlatformOwnerClaims }
  | { scope: "workspace"; claims: ManagerClaims; platformClaims?: PlatformOwnerClaims | null };
type SessionSummary = { id: string; kind: string; tenantId: string | null; tenantName: string | null;
  createdAt: Date; lastRefreshedAt: Date; expiresAt: Date; ipAddress: string | null; userAgent: string | null;
  current: boolean };
type SessionRevocationResult = { found: boolean; signedOut: boolean; revoked: number; clearPlatformCookie?: boolean };
export type SessionRevocationAction = "revoke" | "revoke_others" | "revoke_all";

export class SessionInventoryRequestError extends Error {
  constructor() { super("Invalid session page cursor"); this.name = "SessionInventoryRequestError"; }
}
type Cursor = { v: 1; t: string; i: string };
function cursorSignature(userId: string, body: string): Buffer {
  const secret = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (secret.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  return createHmac("sha256", secret).update("session-inventory-cursor-v1\0").update(userId).update("\0").update(body).digest();
}
function encodeCursor(userId: string, cursor: Cursor): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${body}.${cursorSignature(userId, body).toString("base64url")}`;
}
function decodeCursor(userId: string, value?: string | null): Cursor | null {
  if (value == null) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new SessionInventoryRequestError();
  const [body, signature] = value.split(".");
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== 32 || supplied.toString("base64url") !== signature || !timingSafeEqual(supplied, cursorSignature(userId, body))) throw new SessionInventoryRequestError();
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new SessionInventoryRequestError(); }
  if (!cursor || Object.keys(cursor).sort().join(",") !== "i,t,v" || cursor.v !== 1 || typeof cursor.t !== "string" || !/^\d{1,20}$/.test(cursor.t)
      || typeof cursor.i !== "string" || !/^[a-f0-9]{32}$/.test(cursor.i)) throw new SessionInventoryRequestError();
  return cursor;
}

/** Account ownership is independent of workspace membership. The only exposed
 * tenant labels belong to the signed-in user's own live session families.
 * Filter live policy BEFORE pagination; expired newest rows cannot hide live
 * older sessions. Cursor integrity is bound to this exact account. */
export async function listOwnSessions(owner: SessionInventoryOwner, pageCursor?: string | null, tx?: DbTx): Promise<{ sessions: SessionSummary[]; truncated: boolean; nextCursor: string | null }> {
  const userId = owner.claims.userId;
  if (!userId) throw new WorkspaceSessionExpiredError();
  const cursor = decodeCursor(userId, pageCursor);
  if (owner.scope === "platform") {
    if (!await validatePlatformClaims(owner.claims)) throw new WorkspaceSessionExpiredError();
  } else {
    const current = owner.claims.familyId ? await readWorkspaceSessionState({ ...owner.claims, familyId: owner.claims.familyId,
      kind: owner.claims.kind === "customer" ? "customer" : "manager" }) : null;
    if (!current) throw new WorkspaceSessionExpiredError();
  }
  const accountQuery = sql`SELECT password_hash FROM users WHERE id=${userId} AND email_verified_at IS NOT NULL`;
  const account = tx ? await tx.execute(accountQuery) : await db.execute(accountQuery);
  const passwordHash = account.rows[0]?.password_hash;
  if (typeof passwordHash !== "string") throw new WorkspaceSessionExpiredError();
  const credentialVersion = credentialVersionFor(userId, passwordHash);
  const cursorFilter = cursor ? sql`(issued_us<${cursor.t}::numeric OR (issued_us=${cursor.t}::numeric AND id<${cursor.i}))` : sql`true`;
  const inventoryQuery = sql`
    WITH latest AS (
      SELECT DISTINCT ON (r.family_id) r.* FROM refresh_tokens r
      WHERE r.user_id=${userId} AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()
        AND r.kind IN ('customer','manager','platform')
      ORDER BY r.family_id,r.issued_at DESC,r.id DESC
    ), live AS (
      SELECT r.family_id AS id,r.kind,r.tenant_id AS "tenantId",t.name AS "tenantName",
        EXTRACT(EPOCH FROM r.family_created_at)*1000 AS created_ms,
        EXTRACT(EPOCH FROM r.issued_at)*1000 AS refreshed_ms,
        EXTRACT(EPOCH FROM r.issued_at)*1000000 AS issued_us,
        EXTRACT(EPOCH FROM CASE WHEN r.kind='platform' THEN LEAST(r.expires_at,p.expires_at) ELSE LEAST(r.expires_at,w.expires_at) END)*1000 AS expires_ms,
        r.ip_address AS "ipAddress",r.user_agent AS "userAgent"
      FROM latest r JOIN users u ON u.id=r.user_id AND u.email_verified_at IS NOT NULL
      LEFT JOIN tenants t ON t.id=r.tenant_id
      LEFT JOIN tenant_users m ON m.user_id=r.user_id AND m.tenant_id=r.tenant_id AND m.role=r.role
      LEFT JOIN workspace_session_security w ON w.family_id=r.family_id AND w.kind=r.kind AND w.user_id=r.user_id AND w.tenant_id=r.tenant_id
      LEFT JOIN platform_session_security p ON p.family_id=r.family_id AND p.user_id=r.user_id
      WHERE (r.kind='platform' AND r.tenant_id IS NULL AND u.is_platform_owner=true AND r.email=u.email
        AND p.password_version=encode(sha256(convert_to(u.password_hash,'UTF8')),'hex') AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
        AND p.last_seen_at>clock_timestamp()-interval '30 minutes' AND p.last_seen_at<=clock_timestamp()
        AND p.password_verified_at<=clock_timestamp())
      OR (r.kind IN ('customer','manager') AND t.lifecycle='active' AND m.user_id IS NOT NULL
        AND w.credential_version=${credentialVersion} AND w.expires_at>clock_timestamp()
        AND w.last_seen_at>clock_timestamp()-interval '30 minutes' AND w.last_seen_at<=clock_timestamp()
        AND w.created_at<=clock_timestamp() AND w.password_verified_at<=clock_timestamp())
    ) SELECT * FROM live WHERE ${cursorFilter} ORDER BY issued_us DESC,id DESC LIMIT 101
  `;
  const result = tx ? await tx.execute(inventoryQuery) : await db.execute(inventoryQuery);
  type Row = Omit<SessionSummary, "current" | "createdAt" | "lastRefreshedAt" | "expiresAt">
    & { created_ms: string; refreshed_ms: string; expires_ms: string; issued_us: string };
  const rows = result.rows as Row[];
  const page = rows.slice(0, 100);
  const last = page.at(-1);
  return { sessions: page.map(row => {
    const times = [row.created_ms, row.refreshed_ms, row.expires_ms].map(Number);
    if (!times.every(Number.isFinite)) throw new Error("Invalid persisted session time");
    return { id: row.id, kind: row.kind, tenantId: row.tenantId, tenantName: row.tenantName,
      createdAt: new Date(times[0]), lastRefreshedAt: new Date(times[1]), expiresAt: new Date(times[2]),
      ipAddress: row.ipAddress, userAgent: row.userAgent, current: row.id===owner.claims.familyId };
  }), truncated: rows.length>100, nextCursor: rows.length>100 && last
    ? encodeCursor(userId, { v: 1, t: String(last.issued_us).split(".")[0], i: last.id }) : null };
}

async function requireAuthority(tx: DbTx, owner: SessionInventoryOwner) {
  if (owner.scope === "platform") await requirePlatformActorInTransaction(tx, owner.claims);
  else {
    await requireActiveTenantInTransaction(tx, owner.claims.tenantId);
    await requireManagerActorInTransaction(tx, owner.claims, "tenant.read");
  }
}

// No step-up: revoking the caller's own sessions needs only a valid,
  // non-expired, non-revoked session for that same account (plus tenant /
  // platform authority checks in requireAuthority). No password is asked,
  // and the current session is NOT rotated by a revocation.
export async function revokeOwnSessions(owner: SessionInventoryOwner, action: SessionRevocationAction, id?: string): Promise<SessionRevocationResult> {
  if (!owner.claims.userId || (action === "revoke" && (!id || !/^(?:[a-f0-9]{32}|legacy:[A-Za-z0-9_-]{1,128})$/.test(id)))) {
    return { found: false, signedOut: false, revoked: 0 };
  }
  return db.transaction(async tx => {
    await requireAuthority(tx, owner);
    // The held user lock is shared by initial issuance and refresh, preventing
    // a revocation sweep from missing a concurrently created successor token.
    const target = action === "revoke" ? sql`r.family_id=${id}` : action === "revoke_others" ? sql`r.family_id<>${owner.claims.familyId ?? ""}` : sql`true`;
    const revoked = await tx.execute(sql`UPDATE refresh_tokens r SET revoked_at=clock_timestamp(),revoked_reason='user_session_revocation'
      WHERE r.user_id=${owner.claims.userId} AND r.kind IN ('customer','manager','platform') AND ${target} AND r.revoked_at IS NULL RETURNING r.family_id,r.kind`);
    const families = new Set(revoked.rows.map(r => String(r.family_id)));
    const platformFamilies = [...new Set(revoked.rows.filter(r => r.kind==='platform').map(r => String(r.family_id)))];
    if (platformFamilies.length) {
      await tx.execute(sql`UPDATE platform_session_security SET revoked_at=clock_timestamp()
        WHERE user_id=${owner.claims.userId} AND family_id IN (${sql.join(platformFamilies.map(f => sql`${f}`), sql`, `)})`);
    }
    const legacyTarget = action === "revoke" ? sql`jti=${id?.startsWith("legacy:") ? id.slice(7) : ""}` : sql`true`;
    const legacy = await tx.execute(sql`UPDATE manager_sessions SET revoked_at=clock_timestamp()
      WHERE user_id=${owner.claims.userId} AND ${legacyTarget} AND revoked_at IS NULL RETURNING jti`);
    const legacyCount = legacy.rows.length;
    const count = families.size + legacyCount;
    const found = action !== "revoke" || count > 0;
    let signedOut = action === "revoke_all" || (action === "revoke" && (id === owner.claims.familyId || id === `legacy:${owner.claims.jti}`));
    if (found && owner.scope === "workspace" && !signedOut && !owner.claims.familyId) {
      // Compatibility v1 has no refresh family. End this login only after
      // an authorized successful action; normal sign-in issues a new
      // session without extending the old eight-hour compatibility JWT.
      await tx.execute(sql`UPDATE manager_sessions SET revoked_at=clock_timestamp()
        WHERE jti=${owner.claims.jti} AND user_id=${owner.claims.userId} AND tenant_id=${owner.claims.tenantId}
          AND revoked_at IS NULL`);
      signedOut = true;
    }
    if (count) await writeAuditEvent({ tenantId: owner.scope === "workspace" ? owner.claims.tenantId : null,
      actorType: owner.scope === "platform" ? "platform" : "user", actorId: owner.claims.userId,
      action: "auth.sessions.revoked", resourceType: "session", resourceId: action === "revoke" ? id : action === "revoke_all" ? "all_sessions" : "other_sessions",
      metadata: { count, scope: "account", audience: owner.scope } }, tx);
    // Cookie hygiene only: if the caller also presented a platform session
    // and that family was just revoked, its cookies are cleared. Presenting
    // a platform session is NOT required to revoke platform families — the
    // workspace session for the same account is sufficient (no step-up).
    const presentedPlatform = owner.scope === "workspace" ? owner.platformClaims : null;
    return { found, revoked: count, signedOut,
      ...(presentedPlatform && presentedPlatform.userId === owner.claims.userId && platformFamilies.includes(presentedPlatform.familyId ?? "") ? { clearPlatformCookie: true } : {}) };
  });
}
