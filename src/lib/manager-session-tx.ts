import { createHmac, randomBytes } from "crypto";
import { db } from "../db";
import { managerSessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { requiredRuntimeSecret } from "./runtime-secret";
import { managerCookieHeader, type ManagerClaims, type ManagerRole } from "./manager-auth";

const MAX_AGE_SECONDS = 8 * 60 * 60;

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
): Promise<{ token: string; jti: string; exp: Date }> {
  const jti = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const exp = new Date((now + MAX_AGE_SECONDS) * 1000);
  const claims: ManagerClaims = {
    jti,
    iat: now,
    exp: now + MAX_AGE_SECONDS,
    sub: "manager",
    tenantId,
    role: identity.role,
    ...(identity.userId ? { userId: identity.userId } : {}),
  };
  const token = sign(claims);

  await tx.insert(managerSessions).values({
    jti,
    tenantId,
    userId: identity.userId ?? null,
    role: identity.role,
    expiresAt: exp,
  });

  return { token, jti, exp };
}

export async function revokeManagerSessionInTransaction(tx: TxRunner, jti: string): Promise<void> {
  await tx.update(managerSessions)
    .set({ revokedAt: new Date() })
    .where(eq(managerSessions.jti, jti));
}

export { managerCookieHeader };