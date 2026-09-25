import { db } from "../db";
import { platformSessions, users } from "../db/schema";
import { eq, and, gt, sql } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { requiredRuntimeSecret } from "./runtime-secret";
import { verifyPassword, normalizeEmail } from "./password";
import { verifyScryptPasswordHash } from "./manager-auth";
import { LEGACY_SESSION_MAX_AGE_SECONDS, sessionCookieSecure } from "./session-config";
import { databaseNowMs } from "./database-clock";
import {
  accessCookieHeader,
  clearAccessCookieHeader,
  clearRefreshCookieHeader,
  getAccessTokenFromRequest,
  issueSessionPair,
  verifyAccessTokenSignature,
  refreshCookieHeader,
  type SessionRequestContext,
} from "./session-tokens";

const COOKIE_NAME = "plt_session";
function getSecret(): string {
  const s = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (s.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  return s;
}
function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function compareStringsSafe(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export type PlatformOwnerClaims = {
  jti: string;
  iat: number;
  exp: number;
  sub: "platform_owner";
  userId: string;
  email: string;
  ver?: 2;
  kind?: "platform";
  sid?: string;
  familyId?: string;
};

export class PlatformUnauthorizedError extends Error {
  constructor(message = "Platform Owner authentication required") {
    super(message);
    this.name = "PlatformUnauthorizedError";
  }
}

export class PlatformForbiddenError extends Error {
  constructor(message = "Access restricted to verified Platform Owners") {
    super(message);
    this.name = "PlatformForbiddenError";
  }
}

function verifyLegacyPlatformTokenSignature(token: string): PlatformOwnerClaims | null {
  if (typeof token !== "string" || token.length < 40 || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, signature] = parts;
  try {
    const header = JSON.parse(b64urlDecode(h).toString("utf8")) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
  } catch {
    return null;
  }
  const data = h + "." + p;
  const expected = createHmac("sha256", getSecret()).update(data).digest("base64url");
  if (!compareStringsSafe(signature, expected)) return null;
  try {
    const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as Partial<PlatformOwnerClaims>;
    if (
      claims.sub !== "platform_owner" ||
      typeof claims.userId !== "string" || claims.userId.length < 1 ||
      typeof claims.email !== "string" || claims.email.length < 3 ||
      typeof claims.jti !== "string" || claims.jti.length < 16 ||
      typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) ||
      claims.exp <= claims.iat || claims.exp - claims.iat > LEGACY_SESSION_MAX_AGE_SECONDS
    ) return null;
    return claims as PlatformOwnerClaims;
  } catch {
    return null;
  }
}

export function verifyPlatformTokenSignature(token: string): PlatformOwnerClaims | null {
  const fresh = verifyAccessTokenSignature(token, "platform");
  if (fresh) {
    return {
      jti: fresh.jti, iat: fresh.iat, exp: fresh.exp, sub: "platform_owner",
      userId: fresh.userId!, email: fresh.email!, ver: 2, kind: "platform",
      sid: fresh.sid, familyId: fresh.familyId,
    };
  }
  return verifyLegacyPlatformTokenSignature(token);
}

export async function createPlatformSession(
  userId: string,
  email: string,
  context?: SessionRequestContext,
): Promise<{
  token: string;
  jti: string;
  exp: Date;
  refreshToken: string;
  refreshTokenId: string;
  familyId: string;
  refreshExpiresAt: Date;
}> {
  const pair = await issueSessionPair({
    kind: "platform",
    userId,
    email,
    tenantId: null,
    role: null,
  }, context);
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

export async function validatePlatformClaims(
  claims: PlatformOwnerClaims | null
): Promise<PlatformOwnerClaims | null> {
  if (!claims) return null;

  if (claims.ver === 2 && claims.kind === "platform") {
    const nowMs = await databaseNowMs().catch(() => null);
    if (nowMs === null) return null;
    const nowSec = Math.floor(nowMs / 1000);
    if (claims.exp <= nowSec || claims.iat > nowSec + 60 || claims.exp - claims.iat !== 15 * 60) return null;
    const user = await db.query.users.findFirst({
      where: eq(users.id, claims.userId),
      columns: { id: true, email: true, isPlatformOwner: true, emailVerifiedAt: true },
    });
    if (!user || !user.isPlatformOwner || !user.emailVerifiedAt || user.email !== claims.email) return null;
    return claims;
  }
  const session = await db.query.platformSessions.findFirst({
    where: and(
      eq(platformSessions.jti, claims.jti),
      gt(platformSessions.expiresAt, sql`clock_timestamp()`),
    ),
  });
  if (!session || session.revokedAt) return null;
  if (Math.floor(session.expiresAt.getTime() / 1000) !== claims.exp) return null;
  if (session.userId !== claims.userId) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, claims.userId),
    columns: { id: true, email: true, isPlatformOwner: true, emailVerifiedAt: true },
  });
  if (!user || !user.isPlatformOwner || !user.emailVerifiedAt) return null;

  return claims;
}

export async function validatePlatformOwner(req: Request): Promise<PlatformOwnerClaims | null> {
  const token = getAccessTokenFromRequest(req, "platform");
  if (!token) return null;
  const claims = verifyPlatformTokenSignature(token);
  return claims ? validatePlatformClaims(claims) : null;
}

export async function requirePlatformOwner(req: Request): Promise<PlatformOwnerClaims> {
  const claims = await validatePlatformOwner(req);
  if (!claims) {
    throw new PlatformUnauthorizedError();
  }
  return claims;
}

export async function authenticatePlatformOwner(
  emailInput: string,
  passwordInput: string
): Promise<{ userId: string; email: string } | null> {
  const normalized = normalizeEmail(emailInput);
  if (!normalized || typeof passwordInput !== "string") return null;

  const user = await db.query.users.findFirst({
    where: eq(users.email, normalized),
    columns: { id: true, email: true, passwordHash: true, emailVerifiedAt: true, isPlatformOwner: true },
  });
  if (!user || !user.isPlatformOwner || !user.emailVerifiedAt) return null;

  const valid = user.passwordHash.startsWith("argon2id$")
    ? await verifyPassword(passwordInput, user.passwordHash)
    : await verifyScryptPasswordHash(passwordInput, user.passwordHash);

  if (!valid) return null;
  return { userId: user.id, email: user.email };
}

type LegacyPlatformAuthTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function revokeLegacyPlatformSessionsForUserInTransaction(
  tx: LegacyPlatformAuthTx,
  userId: string,
): Promise<void> {
  await tx.update(platformSessions)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(and(eq(platformSessions.userId, userId), isNull(platformSessions.revokedAt)));
}

export async function revokePlatformSession(jti: string): Promise<void> {
  await db
    .update(platformSessions)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(eq(platformSessions.jti, jti));
}

export async function cleanupExpiredPlatformSessions(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM platform_sessions
    WHERE expires_at <= clock_timestamp()
    RETURNING jti
  `);
  return result.rows.length;
}

export function platformCookieHeader(token: string, exp: Date): string {
  return accessCookieHeader("platform", token, exp);
}

export function platformRefreshCookieHeader(token: string, exp: Date): string {
  return refreshCookieHeader("platform", token, exp);
}

export function clearPlatformCookieHeader(): string {
  return clearAccessCookieHeader("platform");
}

export function clearPlatformRefreshCookieHeader(): string {
  return clearRefreshCookieHeader("platform");
}
