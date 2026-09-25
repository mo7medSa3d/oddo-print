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
