import { db } from "../db";
import { managerSessions } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { issueSessionPairInTransaction, accessCookieHeader } from "./session-tokens";
import type { ManagerRole } from "./manager-auth";

type TxRunner = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(eq(managerSessions.jti, jti));
}

export function managerCookieHeader(token: string, exp: Date): string {
  return accessCookieHeader("manager", token, exp);
}
