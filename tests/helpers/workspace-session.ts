import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../../src/db";
import { tenantUsers, users } from "../../src/db/schema";
import { credentialVersionFor, issueSessionPair, type SharedSessionPrincipal, type SessionRequestContext } from "../../src/lib/session-tokens";
import type { ManagerRole } from "../../src/lib/manager-auth";
import { hashPassword } from "../../src/lib/password";

/** Authorization fixtures represent an already-verified password. The real
 * issuance path still locks/rechecks the password, tenant and membership and
 * persists its normal policy; dedicated login tests use the actual endpoint. */
export async function issueWorkspaceTestSession(
  principal: SharedSessionPrincipal & { userId: string }, context?: SessionRequestContext,
) {
  if (principal.kind === "platform") throw new Error("Use the platform session fixture");
  if (context?.continueWorkspace) return issueSessionPair(principal, context);
  const user = await db.query.users.findFirst({ where: eq(users.id, principal.userId), columns: { passwordHash: true, emailVerifiedAt: true, email: true } });
  if (!user?.emailVerifiedAt || !principal.tenantId || !principal.role) throw new Error("Workspace fixture needs a verified account and tenant membership");
  return issueSessionPair({ ...principal, email: user.email, credentialVersion: credentialVersionFor(principal.userId,user.passwordHash) },context);
}

/** Printer/discovery/authorization fixtures use a real verified workspace
 * account instead of inventing an environment-manager login with no proof.
 * Dedicated authentication tests must still call actual verification paths. */
export async function createWorkspaceManagerTestSession(
  tenantId: string, identity?: { userId?: string; role?: ManagerRole }, context?: SessionRequestContext & { email?: string | null },
) {
  const role = identity?.role ?? "owner";
  let userId = identity?.userId;
  if (!userId) {
    const membership = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.role, role)) });
    userId = membership?.userId;
    if (!userId) {
      userId = "workspace_fixture_" + createHash("sha256").update(tenantId + "\0" + role).digest("hex").slice(0, 24);
      await db.insert(users).values({ id: userId, email: `${userId}@fixture.invalid`, passwordHash: await hashPassword(randomBytes(32).toString("base64url")), emailVerifiedAt: new Date() });
      await db.insert(tenantUsers).values({ userId, tenantId, role });
    }
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { passwordHash: true, emailVerifiedAt: true, email: true } });
  if (!user?.emailVerifiedAt) throw new Error("Manager fixture needs an existing verified account");
  const pair = await issueWorkspaceTestSession({ kind: "manager", tenantId, userId, role, email: user.email }, context);
  return { token: pair.accessToken, jti: pair.accessJti, exp: pair.accessExpiresAt, refreshToken: pair.refreshToken,
    refreshTokenId: pair.refreshTokenId, familyId: pair.familyId, refreshExpiresAt: pair.refreshExpiresAt };
}
