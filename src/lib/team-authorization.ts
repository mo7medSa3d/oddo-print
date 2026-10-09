import { sql, and, eq } from "drizzle-orm";
import type { DbTx } from "../db";
import { tenantUsers } from "../db/schema";
import type { ManagerClaims } from "./manager-auth";
import { hasManagerPermission } from "./authorization";

export class TeamAuthorizationChangedError extends Error {
  constructor() {
    super("Your workspace access changed. Sign in again.");
    this.name = "TeamAuthorizationChangedError";
  }
}

/** Keep the actor's live authority valid through a team mutation commit. */
export async function requireTeamActorInTransaction(
  tx: DbTx, claims: ManagerClaims, relatedUserIds: string[] = [],
): Promise<void> {
  if (!claims.userId) throw new TeamAuthorizationChangedError();
  const ids = [...new Set([claims.userId, ...relatedUserIds])];
  // All team/reset/refresh mutations lock users before session rows. Ordering
  // both actor and target prevents opposite administrator requests deadlocking.
  await tx.execute(sql`SELECT id FROM users
    WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
    ORDER BY id FOR UPDATE`);
  const actor = await tx.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.userId, claims.userId), eq(tenantUsers.tenantId, claims.tenantId)),
    columns: { role: true },
  });
  if (!actor || actor.role !== claims.role || !hasManagerPermission(claims, "users.manage")) {
    throw new TeamAuthorizationChangedError();
  }
  let active;
  if (claims.familyId) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claims.familyId}, 0))`);
    active = await tx.execute(sql`SELECT id FROM refresh_tokens
      WHERE family_id = ${claims.familyId} AND user_id = ${claims.userId}
        AND tenant_id = ${claims.tenantId} AND kind = ${claims.kind ?? "manager"}
        AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND ${claims.exp} > EXTRACT(EPOCH FROM clock_timestamp())
      FOR SHARE`);
  } else {
    active = await tx.execute(sql`SELECT jti FROM manager_sessions
      WHERE jti = ${claims.jti} AND user_id = ${claims.userId}
        AND tenant_id = ${claims.tenantId} AND revoked_at IS NULL
        AND expires_at > clock_timestamp() FOR SHARE`);
  }
  if (active.rows.length === 0) throw new TeamAuthorizationChangedError();
}
