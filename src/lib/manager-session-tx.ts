import { db } from "../db";
import { managerSessions } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { issueSessionPairInTransaction, accessCookieHeader } from "./session-tokens";
import type { ManagerRole } from "./manager-auth";
type TxRunner = Parameters<Parameters<typeof db.transaction>[0]>[0];

function b64urlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(claims: ManagerClaims): string {
  const secret = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (secret.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export async function createManagerSessionInTransaction(
  tx: TxRunner,
  tenantId: string,
  identity: { userId?: string; role: ManagerRole },
): Promise<{
  token: string;
  jti: string;
  exp: Date;
  refreshToken: string;
  refreshTokenId: string;
  familyId: string;
  refreshExpiresAt: Date;
}> {
  const pair = await issueSessionPairInTransaction(tx, {
    kind: "manager",
    tenantId,
    userId: identity.userId ?? null,
    role: identity.role,
  });
  return {
    token: pair.accessToken,
    jti: pair.accessJti,
    exp: pair.accessExpiresAt,
    refreshToken: pair.refreshToken,
    refreshTokenId: pair.refreshTokenId,
    familyId: pair.familyId,
    refreshExpiresAt: pair.refreshExpiresAt,
  };
}


export async function revokeManagerSessionInTransaction(tx: TxRunner, jti: string): Promise<void> {
  await tx.update(managerSessions)
    .set({ revokedAt: sql`now()` })
    .where(eq(managerSessions.jti, jti));
}

export { managerCookieHeader };