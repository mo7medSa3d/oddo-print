import { sql } from "drizzle-orm";
import { db, type DbTx } from "../db";
import type { ManagerClaims } from "./manager-auth";
import type { SharedSessionPrincipal } from "./session-tokens";
import { credentialVersionFor, environmentManagerCredentialVersion, sameCredentialVersion } from "./session-credentials";

export const WORKSPACE_IDLE_MS = 30 * 60 * 1000;
export const WORKSPACE_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** Login-completion window for non-inherited session creation only (AUDIT K3).
 * This is NOT step-up: it never gates an action taken with an existing session. */
export const WORKSPACE_LOGIN_PROOF_WINDOW_MS = 5 * 60 * 1000;
type Connection = Pick<DbTx, "execute">;
type Identity = { familyId: string; kind: "customer" | "manager"; tenantId: string; userId?: string | null; sid?: string; role?: string };
type WorkspaceSessionState = { familyId: string; kind: "customer" | "manager"; tenantId: string; userId: string | null;
  credentialVersion: string; createdAtMs: number; passwordVerifiedAtMs: number; lastSeenAtMs: number; expiresAtMs: number; nowMs: number };

export class WorkspaceSessionExpiredError extends Error {
  readonly code = "SESSION_EXPIRED";
  readonly status = 401;
  constructor() { super("Your session expired or changed. Sign in again."); this.name = "WorkspaceSessionExpiredError"; }
}
export type WorkspacePolicyError = WorkspaceSessionExpiredError;
export function workspacePolicyResponse(error: WorkspacePolicyError): Response {
  return Response.json({ error: error.message, code: error.code }, {
    status: error.status, headers: { "Cache-Control": "private, no-store" },
  });
}

/** Database-clock admission. A refresh timestamp is never treated as user
 * activity, and a missing policy row is never repaired from an old token. */
export async function readWorkspaceSessionState(identity: Identity, connection: Connection = db, lock = false): Promise<WorkspaceSessionState | null> {
  const result = await connection.execute(sql`
    SELECT s.family_id AS "familyId", s.kind, s.tenant_id AS "tenantId", s.user_id AS "userId", s.credential_version AS "credentialVersion",
      EXTRACT(EPOCH FROM s.created_at)*1000 AS "createdAtMs", EXTRACT(EPOCH FROM s.password_verified_at)*1000 AS "passwordVerifiedAtMs",
      EXTRACT(EPOCH FROM s.last_seen_at)*1000 AS "lastSeenAtMs", EXTRACT(EPOCH FROM LEAST(s.expires_at,r.expires_at))*1000 AS "expiresAtMs",
      EXTRACT(EPOCH FROM clock_timestamp())*1000 AS "nowMs", u.password_hash AS "passwordHash", u.email_verified_at IS NOT NULL AS verified
    FROM workspace_session_security s
    JOIN refresh_tokens r ON r.family_id=s.family_id AND r.kind=s.kind AND r.tenant_id=s.tenant_id AND r.user_id IS NOT DISTINCT FROM s.user_id
    JOIN tenants t ON t.id=s.tenant_id AND t.lifecycle='active'
    LEFT JOIN users u ON u.id=s.user_id
    WHERE s.family_id=${identity.familyId} AND s.kind=${identity.kind} AND s.tenant_id=${identity.tenantId}
      AND ${identity.userId ? sql`s.user_id=${identity.userId}` : sql`s.user_id IS NULL`}
      AND ${identity.sid ? sql`r.id=${identity.sid}` : sql`true`}
      AND ${identity.role ? sql`r.role=${identity.role}` : sql`true`}
      AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()
      AND s.last_seen_at>clock_timestamp()-interval '30 minutes'
      AND s.created_at<=clock_timestamp() AND s.password_verified_at<=clock_timestamp() AND s.last_seen_at<=clock_timestamp()
      AND ((s.user_id IS NULL AND s.kind='manager' AND r.role='owner') OR EXISTS
        (SELECT 1 FROM tenant_users m WHERE m.user_id=s.user_id AND m.tenant_id=s.tenant_id AND m.role=r.role))
    ORDER BY r.issued_at DESC,r.id LIMIT 1 ${lock ? sql`FOR UPDATE OF s` : sql``}
  `);
  const raw = result.rows[0] as (WorkspaceSessionState & { passwordHash: string | null; verified: boolean }) | undefined;
  if (!raw) return null;
  const expected = raw.userId
    ? raw.verified && raw.passwordHash ? credentialVersionFor(raw.userId, raw.passwordHash) : null
    : environmentManagerCredentialVersion(raw.tenantId);
  if (!sameCredentialVersion(raw.credentialVersion, expected)) return null;
  const state: WorkspaceSessionState = { familyId: raw.familyId, kind: raw.kind, tenantId: raw.tenantId, userId: raw.userId,
    credentialVersion: raw.credentialVersion, createdAtMs: Number(raw.createdAtMs), passwordVerifiedAtMs: Number(raw.passwordVerifiedAtMs),
    lastSeenAtMs: Number(raw.lastSeenAtMs), expiresAtMs: Number(raw.expiresAtMs), nowMs: Number(raw.nowMs) };
  if (![state.createdAtMs, state.passwordVerifiedAtMs, state.lastSeenAtMs, state.expiresAtMs, state.nowMs].every(Number.isFinite)) throw new Error("Invalid workspace session clock");
  return state;
}

export async function requireWorkspaceSessionInTransaction(tx: DbTx, claims: ManagerClaims, options: { touch?: boolean } = {}) {
  if (claims.ver !== 2 || !claims.sid || !claims.familyId || (claims.kind !== "customer" && claims.kind !== "manager")) throw new WorkspaceSessionExpiredError();
  const state = await readWorkspaceSessionState({ ...claims, familyId: claims.familyId, kind: claims.kind }, tx, true);
  if (!state || claims.exp*1000 <= state.nowMs) throw new WorkspaceSessionExpiredError();
  if (options.touch) {
    const result = await tx.execute(sql`UPDATE workspace_session_security SET last_seen_at=clock_timestamp()
      WHERE family_id=${claims.familyId} AND last_seen_at>clock_timestamp()-interval '30 minutes' AND expires_at>clock_timestamp()
      RETURNING EXTRACT(EPOCH FROM last_seen_at)*1000 AS now_ms`);
    if (!result.rows.length) throw new WorkspaceSessionExpiredError();
    state.lastSeenAtMs = state.nowMs = Number(result.rows[0].now_ms);
  }
  return state;
}

export async function assertWorkspaceCredentialInTransaction(tx: DbTx, principal: Pick<SharedSessionPrincipal, "kind" | "tenantId" | "userId" | "role">, proof: string) {
  if (!principal.tenantId || (principal.kind !== "manager" && principal.kind !== "customer")) throw new WorkspaceSessionExpiredError();
  let expected: string | null = null;
  if (principal.userId) {
    const result = await tx.execute(sql`SELECT password_hash,email_verified_at FROM users WHERE id=${principal.userId} FOR UPDATE`);
    const user = result.rows[0] as { password_hash?: string; email_verified_at?: unknown } | undefined;
    if (user?.password_hash && user.email_verified_at) expected = credentialVersionFor(principal.userId, user.password_hash);
    const membership = await tx.execute(sql`SELECT role FROM tenant_users WHERE user_id=${principal.userId} AND tenant_id=${principal.tenantId}`);
    if (membership.rows[0]?.role !== principal.role) throw new WorkspaceSessionExpiredError();
  } else if (principal.kind === "manager" && principal.role === "owner") expected = environmentManagerCredentialVersion(principal.tenantId);
  if (!sameCredentialVersion(proof, expected)) throw new WorkspaceSessionExpiredError();
}

export async function prepareWorkspaceSessionInTransaction(tx: DbTx, principal: SharedSessionPrincipal, nowMs: number, continuation?: ManagerClaims): Promise<WorkspaceSessionState> {
  if (!principal.tenantId || (principal.kind !== "customer" && principal.kind !== "manager")) throw new WorkspaceSessionExpiredError();
  let inherited: WorkspaceSessionState | undefined;
  if (continuation) {
    if (!principal.userId || continuation.userId !== principal.userId || !continuation.familyId) throw new WorkspaceSessionExpiredError();
    await tx.execute(sql`SELECT id FROM users WHERE id=${principal.userId} FOR UPDATE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${continuation.familyId},0))`);
    inherited = await requireWorkspaceSessionInTransaction(tx, continuation);
  }
  const proof = inherited?.credentialVersion ?? principal.credentialVersion ?? principal.environmentCredentialVersion;
  if (!proof) throw new WorkspaceSessionExpiredError();
  await assertWorkspaceCredentialInTransaction(tx, principal, proof);
  const passwordVerifiedAtMs = inherited?.passwordVerifiedAtMs ?? principal.passwordVerifiedAtMs ?? nowMs;
  // A signed workspace chooser inherits the original password time. Waiting
  // to select a tenant must never manufacture a new login timestamp.
  // NOTE (no-step-up): this five-minute creation window below is a
  // login-flow guard only (see AUDIT K3); it does not gate any action
  // taken with an existing session.
  if (!Number.isFinite(passwordVerifiedAtMs) || passwordVerifiedAtMs > nowMs ||
      (!inherited && nowMs-passwordVerifiedAtMs >= WORKSPACE_LOGIN_PROOF_WINDOW_MS)) throw new WorkspaceSessionExpiredError();
  const createdAtMs = inherited?.createdAtMs ?? passwordVerifiedAtMs;
  return { familyId: "", kind: principal.kind, tenantId: principal.tenantId, userId: principal.userId ?? null,
    credentialVersion: proof, createdAtMs, passwordVerifiedAtMs,
    lastSeenAtMs: Math.max(nowMs, inherited?.nowMs ?? nowMs), expiresAtMs: inherited?.expiresAtMs ?? createdAtMs+WORKSPACE_ABSOLUTE_MS, nowMs };
}

export async function persistWorkspaceSessionInTransaction(tx: DbTx, familyId: string, state: WorkspaceSessionState) {
  await tx.execute(sql`INSERT INTO workspace_session_security
    (family_id,kind,tenant_id,user_id,credential_version,created_at,password_verified_at,last_seen_at,expires_at)
    VALUES (${familyId},${state.kind},${state.tenantId},${state.userId},${state.credentialVersion},${new Date(state.createdAtMs)},
      ${new Date(state.passwordVerifiedAtMs)},${new Date(state.lastSeenAtMs)},${new Date(state.expiresAtMs)})`);
}

