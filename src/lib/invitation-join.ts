import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "../db";
import { tenantInvitations, tenantUsers, users } from "../db/schema";
import { hashToken, normalizeEmail } from "./password";
import { writeAuditEvent } from "./audit";
import { assertSessionCredentialInTransaction, issueSessionPairInTransaction, type SessionRequestContext } from "./session-tokens";
import type { ManagerRole } from "./manager-auth";

type ActiveWorkspaceInvitation = typeof tenantInvitations.$inferSelect;

/** Invitation links are bearer proofs of an offer, NOT login credentials. */
export async function findActiveInvitation(token: string): Promise<ActiveWorkspaceInvitation | null> {
  if (!token || token.length > 256) return null;
  const digest = await hashToken(token);
  const invitation = await db.query.tenantInvitations.findFirst({
    where: and(eq(tenantInvitations.tokenHash, digest),
      isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt),
      gt(tenantInvitations.expiresAt, sql`clock_timestamp()`)),
  });
  return invitation ?? null;
}

/** Caller MUST join with the invited, email-verified identity. The tenant
 * lock precedes user and membership writes (same order as suspension).
 * Invitation consumption + membership are one transaction: no orphan joins.
 */
export async function joinWorkspaceByInvitation(
  tx: DbTx, invitation: ActiveWorkspaceInvitation,
  userId: string, verifiedEmail: string,
): Promise<{ tenantId: string; role: string }> {
  const tenant = await tx.execute(sql`
    SELECT id, lifecycle FROM tenants WHERE id = ${invitation.tenantId} FOR UPDATE
  `);
  if (!tenant.rows[0]?.id || tenant.rows[0].lifecycle !== "active")
    throw new Error("INVITATION_WORKSPACE_UNAVAILABLE");

  const liveInvite = await tx.query.tenantInvitations.findFirst({
    where: and(eq(tenantInvitations.id, invitation.id),
      eq(tenantInvitations.tokenHash, invitation.tokenHash),
      isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt),
      gt(tenantInvitations.expiresAt, sql`clock_timestamp()`)),
  });
  if (!liveInvite || normalizeEmail(liveInvite.email) !== normalizeEmail(verifiedEmail))
    throw new Error("INVITATION_INVALID");
  const verified = await tx.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true, emailVerifiedAt: true },
  });
  if (!verified?.emailVerifiedAt || normalizeEmail(verified.email) !== normalizeEmail(liveInvite.email))
    throw new Error("INVITATION_IDENTITY_MISMATCH");

  const member = await tx.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, liveInvite.tenantId), eq(tenantUsers.userId, userId)),
    columns: { userId: true },
  });
  if (member) throw new Error("INVITATION_ALREADY_MEMBER");
  const consumed = await tx.update(tenantInvitations)
    .set({ acceptedAt: sql`clock_timestamp()` })
    .where(and(eq(tenantInvitations.id, liveInvite.id),
      isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt),
      gt(tenantInvitations.expiresAt, sql`clock_timestamp()`)))
    .returning({ id: tenantInvitations.id });
  if (consumed.length !== 1) throw new Error("INVITATION_INVALID");
  const inserted = await tx.insert(tenantUsers)
    .values({ tenantId: liveInvite.tenantId, userId, role: liveInvite.role })
    .onConflictDoNothing()
    .returning({ userId: tenantUsers.userId });
  if (inserted.length !== 1) throw new Error("INVITATION_ALREADY_MEMBER");
  await writeAuditEvent({ tenantId: liveInvite.tenantId, actorType: "user",
    actorId: userId, action: "team.invitation.accepted",
    resourceType: "tenant_invitation", resourceId: liveInvite.id }, tx);
  return { tenantId: liveInvite.tenantId, role: liveInvite.role };
}

/** A freshly password-authenticated identity can accept an offer even after
 * losing its last active membership. An invitation is never authentication:
 * the locked credential snapshot must still match before membership is added.
 * Admission and session persistence commit together or both roll back. */
export async function joinInvitationWithPassword(
  token: string,
  principal: { userId: string; email: string; credentialVersion: string },
  context?: SessionRequestContext,
) {
  const invitation = await findActiveInvitation(token);
  if (!invitation || normalizeEmail(invitation.email) !== normalizeEmail(principal.email))
    throw new Error("INVITATION_INVALID");
  return db.transaction(async tx => {
    // Match lifecycle writers: invited tenant before the authenticated user.
    const tenant = await tx.execute(sql`SELECT id, lifecycle FROM tenants WHERE id=${invitation.tenantId} FOR UPDATE`);
    if (tenant.rows[0]?.lifecycle !== "active") throw new Error("INVITATION_WORKSPACE_UNAVAILABLE");
    await assertSessionCredentialInTransaction(tx, principal.userId, principal.credentialVersion);
    const membership = await joinWorkspaceByInvitation(tx, invitation, principal.userId, principal.email);
    const session = await issueSessionPairInTransaction(tx, {
      kind: "customer", ...principal, tenantId: membership.tenantId, role: membership.role as ManagerRole,
    }, context);
    return { membership, session };
  });
}
