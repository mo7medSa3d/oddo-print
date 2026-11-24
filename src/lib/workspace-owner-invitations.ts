import { sql } from "drizzle-orm";
import type { DbTx } from "../db";
import type { ManagerClaims } from "./manager-auth";
import { requireManagerActorInTransaction } from "./manager-mutation-authorization";
import { ManualSubscriptionError } from "./manual-subscriptions";

/**
 * Only a live, password-authenticated Workspace session belonging to a
 * *verified workspace owner* may send or revoke invitations in its own tenant.
 *
 * Only the current verified "owner" membership role grants this authority.
 * The Manager guard locks the principal/session and checks revocation inside
 * the same transaction as the invitation write; this check holds the owner
 * identity lock until commit. No repeated password/5-minute step-up is needed
 * for this narrowly scoped operation. Other Platform APIs remain unchanged.
 */
export async function requireWorkspaceOwnerForInvites(
  tx: DbTx, claims: ManagerClaims,
): Promise<void> {
  if (!claims.userId || claims.role !== "owner" || claims.ver !== 2 ||
      (claims.kind !== "customer" && claims.kind !== "manager") ||
      !claims.familyId || !claims.sid) {
    throw new ManualSubscriptionError("OWNER_REQUIRED", 403);
  }
  await requireManagerActorInTransaction(tx, claims, "users.read");
  const verified = await tx.execute(sql`
    SELECT 1 FROM users u
    JOIN tenant_users m ON m.user_id=u.id
    WHERE u.id=${claims.userId} AND m.tenant_id=${claims.tenantId}
      AND m.role=${claims.role} AND m.role='owner'
      AND u.email_verified_at IS NOT NULL
    LIMIT 1
  `);
  if (verified.rows.length !== 1) {
    throw new ManualSubscriptionError("OWNER_REQUIRED", 403);
  }
}
