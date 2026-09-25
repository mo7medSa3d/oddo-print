import { db } from "../db";
import { managerSessions, tenants, tenantDomains, tenantUsers, users } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { createHash, createHmac, scrypt, timingSafeEqual } from "crypto";
import { requiredRuntimeSecret, runtimeSecret } from "./runtime-secret";
import { databaseNowMs } from "./database-clock";
import { hashPassword, verifyPassword, normalizeEmail } from "./password";
import { requireActiveTenantOrNull } from "./tenant-guard";
import { SESSION_MAX_AGE_SECONDS } from "./session-config";
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

const COOKIE_NAME = "mgr_session";
const MAX_AGE_SECONDS = SESSION_MAX_AGE_SECONDS;

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

export type ManagerRole = "owner" | "admin" | "operator" | "viewer" | "integration_admin" | "billing_admin";
export type ManagerClaims = {
  jti: string; iat: number; exp: number; sub: "manager"; tenantId: string;
  userId?: string; role: ManagerRole;
  ver?: 2;
  kind?: "manager" | "customer";
  sid?: string;
  familyId?: string;
};

function sign(claims: ManagerClaims): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifySignature(token: string): ManagerClaims | null {
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
    const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as Partial<ManagerClaims>;
    if (
      claims.sub !== "manager" ||
      typeof claims.tenantId !== "string" ||
      claims.tenantId.length < 1 ||
      claims.tenantId.length > 128 ||
      typeof claims.jti !== "string" ||
      claims.jti.length < 16 ||
      claims.jti.length > 128 ||
      typeof claims.iat !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_AGE_SECONDS ||
      typeof claims.role !== "string" ||
      !(["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"] as string[]).includes(claims.role) ||
      (claims.userId !== undefined && (typeof claims.userId !== "string" || claims.userId.length < 1 || claims.userId.length > 128))
    ) return null;
    return claims as ManagerClaims;
  } catch {
    return null;
  }
}

export function getManagerCookieName() {
  return COOKIE_NAME;
}

export async function verifyManagerToken(token: string): Promise<ManagerClaims | null> {
  const versioned = verifyAccessTokenSignature(token, "manager");
  if (versioned) {
    if (versioned.kind !== "manager") return null;
    return validateManagerClaims({
      jti: versioned.jti,
      iat: versioned.iat,
      exp: versioned.exp,
      sub: "manager",
      tenantId: versioned.tenantId!,
      role: versioned.role as ManagerRole,
      ...(versioned.userId ? { userId: versioned.userId } : {}),
      ver: 2,
      kind: "manager",
      sid: versioned.sid,
      familyId: versioned.familyId,
    });
  }

  const legacy = verifySignature(token);
  return legacy ? validateManagerClaims(legacy) : null;
}

export async function validateManagerClaims(claims: ManagerClaims | null): Promise<ManagerClaims | null> {
  if (!claims) return null;

  if (claims.ver === 2 && (claims.kind === "manager" || claims.kind === "customer")) {
    let nowMs: number;
    try {
      nowMs = await databaseNowMs();
    } catch {
      return null;
    }
    const nowSec = Math.floor(nowMs / 1000);
    if (claims.exp <= nowSec || claims.iat > nowSec + 60 || claims.exp - claims.iat !== 15 * 60) return null;
    if (!claims.tenantId || !claims.role) return null;

    if (claims.userId) {
      const membership = await db.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.userId, claims.userId), eq(tenantUsers.tenantId, claims.tenantId)),
        columns: { role: true },
      });
      if (!membership || membership.role !== claims.role) return null;
    }

    const tenantLifecycle = await requireActiveTenantOrNull(claims.tenantId);
    if (!tenantLifecycle) return null;
    return claims;
  }

  const row = await db.query.managerSessions.findFirst({
    where: and(
      eq(managerSessions.jti, claims.jti),
      sql`${managerSessions.expiresAt} > clock_timestamp()`,
      sql`${claims.iat} <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) + 60`,
    ),
  });
  if (!row || row.revokedAt) return null;
  // The durable session row is authoritative for expiry and must agree with
  // the signed JWT. No host-clock comparison is used for session validity.
  if (Math.floor(row.expiresAt.getTime() / 1000) !== claims.exp) return null;
  if (row.tenantId !== claims.tenantId || row.role !== claims.role || (row.userId ?? undefined) !== claims.userId) return null;
  if (row.userId) {
    const membership = await db.query.tenantUsers.findFirst({
      where: and(eq(tenantUsers.userId, row.userId), eq(tenantUsers.tenantId, row.tenantId)),
      columns: { role: true },
    });
    if (!membership || membership.role !== row.role) return null;
  }
  // Tenant lifecycle denials are an expected authentication outcome. Unexpected
  // database/transport failures must propagate as operational errors rather than
  // being misclassified as invalid credentials.
  const tenantLifecycle = await requireActiveTenantOrNull(claims.tenantId);
  if (!tenantLifecycle) return null;
  return claims;
}

function normalizeHost(host: string | null): string | null {
  if (!host) return null;
  const raw = host.trim().toLowerCase().replace(/\.$/, "");
  if (!raw || raw.length > 255 || raw.includes("@") || raw.includes("/")) return null;
  const withoutPort = raw.startsWith("[") ? raw.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1") : raw.replace(/:\d+$/, "");
  if (!withoutPort || withoutPort.length > 253) return null;
  return withoutPort;
}

/** Resolve the manager tenant from the trusted request host. A static env mapping is only a bootstrap fallback. */
export async function resolveManagerTenantId(req: Request): Promise<string | null> {
  const host = normalizeHost(req.headers.get("host"));
  if (host) {
    const domain = await db.query.tenantDomains.findFirst({
      where: eq(tenantDomains.domain, host),
      columns: { tenantId: true, verifiedAt: true },
    });
    if (domain?.verifiedAt) return domain.tenantId;
  }

  const configured = runtimeSecret("MANAGER_TENANT_ID")?.trim();
  if (configured) {
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, configured), columns: { id: true } });
    if (tenant) return tenant.id;
  }

  // Never infer the login tenant from the number of rows in the database.
  // A global bootstrap credential must be explicitly pinned to one tenant;
  // otherwise an attacker who controls Host could turn the legacy credential
  // into a cross-tenant owner login.
  return null;
}

export async function createManagerSession(
  tenantId: string,
  identity?: { userId?: string; role?: ManagerRole },
  context?: SessionRequestContext & { email?: string | null },
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
    kind: "manager",
    tenantId,
    userId: identity?.userId ?? null,
    role: identity?.role ?? "owner",
    email: context?.email ?? null,
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

export async function validateManager(req: Request): Promise<ManagerClaims | null> {
  const token = getAccessTokenFromRequest(req, "manager");
  return token ? verifyManagerToken(token) : null;
}

export async function revokeManagerSession(jti: string) {
  await db.update(managerSessions).set({ revokedAt: sql`clock_timestamp()` }).where(eq(managerSessions.jti, jti));
}

export async function cleanupExpiredManagerSessions(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM manager_sessions
    WHERE expires_at <= clock_timestamp()
    RETURNING jti
  `);
  return result.rows.length;
}

export function managerCookieHeader(token: string, exp: Date): string {
  return accessCookieHeader("manager", token, exp);
}

export function managerRefreshCookieHeader(token: string, exp: Date): string {
  return refreshCookieHeader("manager", token, exp);
}

export function clearManagerCookieHeader(): string {
  return clearAccessCookieHeader("manager");
}

export function clearManagerRefreshCookieHeader(): string {
  return clearRefreshCookieHeader("manager");
}

function compareStringsSafe(a: string, b: string): boolean {
  // Hash both inputs to fixed-length SHA-256 digests before comparing,
  // so no code path branches on secret length (matching agent-auth.ts).
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(derivedKey);
    });
  });
}

export async function verifyManagerPassword(username: string, input: string): Promise<boolean> {
  const expectedUser = runtimeSecret("MANAGER_USERNAME");
  const expectedHash = runtimeSecret("MANAGER_PASSWORD_HASH");
  const expectedPass = runtimeSecret("MANAGER_PASSWORD");
  if (!expectedUser || typeof input !== "string") return false;

  const userOk = compareStringsSafe(username, expectedUser);
  if (!userOk) {
    // Preserve a comparable amount of password KDF work for unknown users
    // without blocking the Node.js event loop.
    if (expectedHash?.includes(":")) {
      const [salt] = expectedHash.split(":", 1);
      if (salt) await scryptAsync(input, salt, 32).catch(() => undefined);
    }
    return false;
  }

  if (expectedHash && expectedHash.includes(":")) {
    const [salt, hash] = expectedHash.split(":");
    if (!salt || !hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return false;
    const derived = await scryptAsync(input, salt, 32);
    return compareStringsSafe(derived.toString("hex"), hash.toLowerCase());
  }

  if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !expectedPass) return false;
  return compareStringsSafe(input, expectedPass);
}

export async function verifyScryptPasswordHash(input: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":", 2);
  if (!salt || !hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return false;
  const derived = await scryptAsync(input, salt, 32);
  return compareStringsSafe(derived.toString("hex"), hash.toLowerCase());
}

export async function authenticateManagerUser(username: string, password: string, tenantId: string): Promise<{ userId: string; role: ManagerRole } | null> {
  const normalized = normalizeEmail(username);
  if (!normalized || typeof password !== "string") return null;
  const row = await db.query.users.findFirst({
    where: eq(users.email, normalized),
    columns: { id: true, passwordHash: true, emailVerifiedAt: true },
  });
  if (!row || !row.emailVerifiedAt) return null;
  const valid = row.passwordHash.startsWith("argon2id$")
    ? await verifyPassword(password, row.passwordHash)
    : await verifyScryptPasswordHash(password, row.passwordHash);
  if (!valid) return null;
  if (!row.passwordHash.startsWith("argon2id$")) {
    // Upgrade only if the legacy hash is still the value that was verified.
    // A concurrent password reset must never be overwritten by login migration.
    const legacyHash = row.passwordHash;
    const upgraded = await hashPassword(password);
    const current = await db.query.users.findFirst({
      where: eq(users.id, row.id),
      columns: { passwordHash: true },
    });
    if (!current || current.passwordHash !== legacyHash) return null;
    const upgradedRows = await db.update(users)
      .set({ passwordHash: upgraded, updatedAt: sql`now()` })
      .where(and(eq(users.id, row.id), eq(users.passwordHash, legacyHash)))
      .returning({ id: users.id });
    if (upgradedRows.length !== 1) return null;
  }
  const membership = await db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.userId, row.id), eq(tenantUsers.tenantId, tenantId)),
    columns: { role: true },
  });
  if (!membership) return null;
  if (!( ["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"] as string[]).includes(membership.role)) return null;
  return { userId: row.id, role: membership.role as ManagerRole };
}

export async function authenticateCustomer(email: string, password: string): Promise<{ userId: string; email: string } | null> {
  const normalized = normalizeEmail(email);
  const row = await db.query.users.findFirst({
    where: eq(users.email, normalized),
    columns: { id: true, email: true, passwordHash: true, emailVerifiedAt: true },
  });
  if (!row || !row.emailVerifiedAt) return null;
  const valid = row.passwordHash.startsWith("argon2id$")
    ? await verifyPassword(password, row.passwordHash)
    : await verifyScryptPasswordHash(password, row.passwordHash);
  if (!valid) return null;
  if (!row.passwordHash.startsWith("argon2id$")) {
    const legacyHash = row.passwordHash;
    const upgraded = await hashPassword(password);
    const current = await db.query.users.findFirst({
      where: eq(users.id, row.id),
      columns: { passwordHash: true },
    });
    if (!current || current.passwordHash !== legacyHash) return null;
    const upgradedRows = await db.update(users)
      .set({ passwordHash: upgraded, updatedAt: sql`now()` })
      .where(and(eq(users.id, row.id), eq(users.passwordHash, legacyHash)))
      .returning({ id: users.id });
    if (upgradedRows.length !== 1) return null;
  }
  return { userId: row.id, email: row.email };
}

export async function getAuthenticatedUserClaims(req: Request): Promise<ManagerClaims | null> {
  return validateManager(req);
}

export function getManagerUsername(): string | null {
  return runtimeSecret("MANAGER_USERNAME") ?? null;
}
