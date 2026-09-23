import { db } from "../db";
import { tenantUsers, authRateLimits } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { authenticateCustomer, createManagerSession, managerCookieHeader, type ManagerRole } from "./manager-auth";
import { normalizeEmail } from "./password";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { requiredRuntimeSecret } from "./runtime-secret";
import { nanoid } from "./nanoid";
import { requireActiveTenantOrNull } from "./tenant-guard";

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

export type TenantSelectionClaims = {
  jti: string;
  iat: number;
  exp: number;
  sub: "tenant_selection";
  userId: string;
  email: string;
};

export async function createTenantSelectionToken(userId: string, email: string): Promise<string> {
  const clock = await db.execute(sql`SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec`);
  const now = Number(clock.rows[0]?.now_sec);
  if (!Number.isSafeInteger(now)) throw new Error("Database clock is unavailable");
  const claims: TenantSelectionClaims = {
    jti: `tsel_${nanoid(20)}`,
    iat: now,
    exp: now + 5 * 60,
    sub: "tenant_selection",
    userId,
    email,
  };
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export async function verifyTenantSelectionToken(token: string): Promise<TenantSelectionClaims | null> {
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
    const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as Partial<TenantSelectionClaims>;
    if (
      claims.sub !== "tenant_selection" ||
      typeof claims.jti !== "string" ||
      !claims.jti.startsWith("tsel_") ||
      typeof claims.userId !== "string" ||
      typeof claims.email !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp)
    ) {
      return null;
    }
    const clock = await db.execute(sql`SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec`);
    const now = Number(clock.rows[0]?.now_sec);
    if (!Number.isSafeInteger(now)) return null;
    if (claims.exp <= now || claims.iat > now + 60) return null;
    return claims as TenantSelectionClaims;
  } catch {
    return null;
  }
}
export async function issueCustomerSession(userId: string, tenantId: string, role: ManagerRole) {
  const tenantLifecycle = await requireActiveTenantOrNull(tenantId);
  if (!tenantLifecycle) return null;
  const session = await createManagerSession(tenantId, { userId, role });
  return session;
}

export function customerSessionCookie(session: { token: string; exp: Date }) {
  return managerCookieHeader(session.token, session.exp);
}

export async function authenticateForTenant(email: string, password: string, tenantId?: string) {
  const identity = await authenticateCustomer(email, password);
  if (!identity) return null;
  if (tenantId) {
    const membership = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.userId, identity.userId), eq(tenantUsers.tenantId, tenantId)), columns: { tenantId: true, role: true } });
    if (!membership) return null;
    if (!(await requireActiveTenantOrNull(membership.tenantId))) return null;
    return { ...identity, tenantId: membership.tenantId, role: membership.role as ManagerRole };
  }
  const memberships = await db.select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role }).from(tenantUsers).where(eq(tenantUsers.userId, identity.userId)).limit(50);
  if (memberships.length === 0) {
    return { ...identity, multipleTenants: false, memberships: [] };
  }
  if (memberships.length > 1) {
    const selectionToken = await createTenantSelectionToken(identity.userId, identity.email);
    return { ...identity, multipleTenants: true, selectionToken, memberships };
  }
  if (!(await requireActiveTenantOrNull(memberships[0].tenantId))) return null;
  return { ...identity, tenantId: memberships[0].tenantId, role: memberships[0].role as ManagerRole };
}

export { normalizeEmail };

