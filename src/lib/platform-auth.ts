import { db } from "../db";
import { platformSessions, users } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { requiredRuntimeSecret } from "./runtime-secret";
import { verifyPassword, normalizeEmail } from "./password";
import { verifyScryptPasswordHash } from "./manager-auth";

const COOKIE_NAME = "plt_session";
const MAX_AGE_SECONDS = 8 * 60 * 60;

function getSecret(): string {
  const s = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (s.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  return s;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
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

function sign(claims: PlatformOwnerClaims): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyPlatformToken(token: string): PlatformOwnerClaims | null {
  if (typeof token !== "string" || token.length < 40 || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  try {
    const header = JSON.parse(b64urlDecode(h).toString("utf8")) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
  } catch {
    return null;
  }

  const data = `${h}.${p}`;
  const expected = createHmac("sha256", getSecret()).update(data).digest("base64url");
  if (!compareStringsSafe(s, expected)) return null;

  try {
    const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as Partial<PlatformOwnerClaims>;
    if (
      claims.sub !== "platform_owner" ||
      typeof claims.userId !== "string" ||
      claims.userId.length < 1 ||
      typeof claims.email !== "string" ||
      claims.email.length < 3 ||
      typeof claims.jti !== "string" ||
      claims.jti.length < 16 ||
      typeof claims.iat !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_AGE_SECONDS
    ) {
      return null;
    }
    if (claims.exp * 1000 <= Date.now()) return null;
    if (claims.iat * 1000 > Date.now() + 60_000) return null;
    return claims as PlatformOwnerClaims;
  } catch {
    return null;
  }
}

export function getPlatformCookieName(): string {
  return COOKIE_NAME;
}

export async function createPlatformSession(
  userId: string,
  email: string
): Promise<{ token: string; jti: string; exp: Date }> {
  const jti = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MAX_AGE_SECONDS;
  const claims: PlatformOwnerClaims = {
    jti,
    iat: now,
    exp,
    sub: "platform_owner",
    userId,
    email,
  };
  const token = sign(claims);
  await db.insert(platformSessions).values({
    jti,
    userId,
    expiresAt: new Date(exp * 1000),
  });
  return { token, jti, exp: new Date(exp * 1000) };
}

export async function validatePlatformClaims(
  claims: PlatformOwnerClaims | null
): Promise<PlatformOwnerClaims | null> {
  if (!claims) return null;
  const session = await db.query.platformSessions.findFirst({
    where: eq(platformSessions.jti, claims.jti),
  });
  if (!session || session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.userId !== claims.userId) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, claims.userId),
    columns: { id: true, email: true, isPlatformOwner: true, emailVerifiedAt: true },
  });
  if (!user || !user.isPlatformOwner || !user.emailVerifiedAt) return null;

  return claims;
}

export async function validatePlatformOwner(req: Request): Promise<PlatformOwnerClaims | null> {
  let token: string | null = null;
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) {
      token = rest.join("=").trim();
      if (token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1);
      break;
    }
  }
  if (!token) {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) token = auth.slice(7).trim();
  }
  if (!token) return null;
  const claims = verifyPlatformToken(token);
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

export async function revokePlatformSession(jti: string): Promise<void> {
  await db
    .update(platformSessions)
    .set({ revokedAt: new Date() })
    .where(eq(platformSessions.jti, jti));
}

function platformCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function platformCookieHeader(token: string, exp: Date): string {
  const secure = platformCookieSecure() ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${exp.toUTCString()}; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearPlatformCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}
