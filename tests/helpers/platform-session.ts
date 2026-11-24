import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { credentialVersionFor, issueSessionPair, type SessionRequestContext } from "../../src/lib/session-tokens";

/** Authorization fixture boundary: represents an already-verified password.
 * Actual issuance rechecks current credentials and owner authority under lock.
 * Authentication regressions call the real password endpoint instead. */
export async function createVerifiedPlatformPair(userId: string, email: string, context?: SessionRequestContext) {
  const user = await db.query.users.findFirst({ where: eq(users.id,userId), columns: { passwordHash: true } });
  if (!user) throw new Error("Missing platform test account");
  return issueSessionPair({ kind: "platform",userId,email,credentialVersion: credentialVersionFor(userId,user.passwordHash) },context);
}

export async function createVerifiedPlatformSession(userId: string, email: string, context?: SessionRequestContext) {
  const pair = await createVerifiedPlatformPair(userId, email, context);
  return { token: pair.accessToken, jti: pair.accessJti, exp: pair.accessExpiresAt, refreshToken: pair.refreshToken,
    refreshTokenId: pair.refreshTokenId, familyId: pair.familyId, refreshExpiresAt: pair.refreshExpiresAt };
}
