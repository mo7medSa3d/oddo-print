import { sql, and, eq } from "drizzle-orm";
import type { DbTx } from "../db";
import { tenantUsers } from "../db/schema";
import type { ManagerClaims } from "./manager-auth";
import { hasManagerPermission, type ManagerPermission } from "./authorization";
import { requireWorkspaceSessionInTransaction, WorkspaceSessionExpiredError,
  workspacePolicyResponse, type WorkspacePolicyError } from "./workspace-session-security";

export class ManagerMutationAuthorityChangedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(readonly policy?: WorkspacePolicyError) {
    super(policy?.message ?? "Your workspace authorization changed. Refresh your session and try again.");
    this.name = "ManagerMutationAuthorityChangedError";
    this.code = policy?.code ?? "WORKSPACE_AUTHORITY_CHANGED";
    this.status = policy?.status ?? 403;
  }
  response(): Response { return this.policy ? workspacePolicyResponse(this.policy) : Response.json({ error: this.message }, { status: 403 }); }
}

/**
 * Validate the already-authenticated Workspace principal at the transaction's
 * mutation boundary, while holding membership/session locks until commit.
 *
 * Callers MUST acquire any required resource locks and an active-tenant fence
 * before this guard, preserving each existing writer's lock order. Never
 * substitute `users.manage` for the permission of the actual operation.
 * User-less environment Managers require an explicitly configured,
 * password-authenticated v2 policy row. Pre-policy and v1 sessions must sign in.
 */
export async function requireManagerActorInTransaction(
  tx: DbTx,
  claims: ManagerClaims,
  permission: ManagerPermission,
  relatedUserIds: string[] = [],
): Promise<void> {
  if (!hasManagerPermission(claims, permission)) throw new ManagerMutationAuthorityChangedError();
  const ids = [...new Set([claims.userId, ...relatedUserIds].filter((id): id is string => !!id))].sort();
  if (ids.length) {
    await tx.execute(sql`SELECT id FROM users
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ORDER BY id FOR UPDATE`);
  }
  if (claims.userId) {
    const member = await tx.query.tenantUsers.findFirst({
      where: and(eq(tenantUsers.userId, claims.userId), eq(tenantUsers.tenantId, claims.tenantId)),
      columns: { role: true },
    });
    if (!member || member.role !== claims.role) throw new ManagerMutationAuthorityChangedError();
  }
  let active;
  if (claims.familyId) {
    if (claims.ver !== 2 || !claims.sid) throw new ManagerMutationAuthorityChangedError();
    // Password reset and logout use this family advisory lock; the guard
    // shares their revocation ordering. Never read an arbitrary user's family.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claims.familyId}, 0))`);
    const userPredicate = claims.userId ? sql`user_id = ${claims.userId}` : sql`user_id IS NULL`;
    const kind = claims.kind === "customer" ? "customer" : "manager";
    active = await tx.execute(sql`SELECT id FROM refresh_tokens
      WHERE id = ${claims.sid} AND family_id = ${claims.familyId} AND tenant_id = ${claims.tenantId}
        AND kind = ${kind} AND ${userPredicate} AND role = ${claims.role}
        AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND ${claims.exp} > EXTRACT(EPOCH FROM clock_timestamp())
      FOR SHARE`);
  } else {
    const userPredicate = claims.userId ? sql`user_id = ${claims.userId}` : sql`user_id IS NULL`;
    active = await tx.execute(sql`SELECT jti FROM manager_sessions
      WHERE jti = ${claims.jti} AND tenant_id = ${claims.tenantId}
        AND ${userPredicate} AND role = ${claims.role}
        AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND FLOOR(EXTRACT(EPOCH FROM expires_at)) = ${claims.exp}
        AND ${claims.exp} > EXTRACT(EPOCH FROM clock_timestamp())
      FOR SHARE`);
  }
  if (active.rows.length === 0) throw new ManagerMutationAuthorityChangedError(new WorkspaceSessionExpiredError());
  try {
    // No step-up: a valid, non-expired, non-revoked session authorizes every
    // permission, sensitive or not. Only session expiry can fail here.
    await requireWorkspaceSessionInTransaction(tx, claims, { touch: !permission.endsWith(".read") });
  } catch (error) {
    if (error instanceof WorkspaceSessionExpiredError) throw new ManagerMutationAuthorityChangedError(error);
    throw error;
  }
}
