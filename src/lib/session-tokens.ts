import { db } from "../db";
import { refreshTokens } from "../db/schema";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { sql } from "drizzle-orm";
import { databaseNowMs } from "./database-clock";
import { requiredRuntimeSecret } from "./runtime-secret";
import { sessionCookieSecure } from "./session-config";
import { sendTransactionalEmail } from "./email";
import { writeAuditEvent } from "./audit";
import { logError, logWarn } from "./log";

export type SessionKind = "manager" | "platform" | "customer";

type SessionKindConfig = {
  sub: "manager" | "platform_owner";
  accessCookieName: string;
  refreshCookieName: string;
  refreshCookiePath: string;
};

const CONFIG: Record<SessionKind, SessionKindConfig> = {
  manager: {
    sub: "manager",
    accessCookieName: "mgr_session",
    refreshCookieName: "mgr_refresh",
    refreshCookiePath: "/api/auth/manager",
  },
  customer: {
    sub: "manager",
    accessCookieName: "mgr_session",
    refreshCookieName: "cust_refresh",
    refreshCookiePath: "/api/auth",
  },
  platform: {
    sub: "platform_owner",
    accessCookieName: "plt_session",
    refreshCookieName: "plt_refresh",
    refreshCookiePath: "/api/platform/auth",
  },
};

export const ACCESS_TOKEN_VERSION = 2 as const;
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_ROTATION_GRACE_MS = 5_000;

export type SharedSessionPrincipal = {
  kind: SessionKind;
  tenantId?: string | null;
  userId?: string | null;
  role?: string | null;
  email?: string | null;
};

export type SessionRequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SharedSessionClaims = {
  ver: 2;
  kind: SessionKind;
  jti: string;
  sid: string;
  familyId: string;
  iat: number;
  exp: number;
  sub: "manager" | "platform_owner";
  tenantId?: string;
  userId?: string;
  role?: string;
  email?: string;
};

export type SessionPair = {
  accessToken: string;
  accessJti: string;
  refreshToken: string;
  refreshTokenId: string;
  familyId: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};

export type RefreshResult =
  | { status: "rotated"; pair: SessionPair }
  | { status: "invalid" }
  | {
      status: "reused";
      familyId: string;
      notificationEmail: string | null;
      tenantId: string | null;
      userId: string | null;
      kind: SessionKind;
    };

function getSecret(): string {
  const secret = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (secret.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  return secret;
}

function configFor(kind: SessionKind): SessionKindConfig {
  return CONFIG[kind];
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function compareStringsSafe(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function signAccessToken(claims: SharedSessionClaims): string {
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verifySignatureShape(token: string): SharedSessionClaims | null {
  if (typeof token !== "string" || token.length < 80 || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;

  try {
    const header = JSON.parse(decode(headerPart).toString("utf8")) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const claims = JSON.parse(decode(payloadPart).toString("utf8")) as Partial<SharedSessionClaims>;
    if (
      claims.ver !== ACCESS_TOKEN_VERSION ||
      (claims.kind !== "manager" && claims.kind !== "platform" && claims.kind !== "customer") ||
      typeof claims.jti !== "string" ||
      claims.jti.length < 16 || claims.jti.length > 128 ||
      typeof claims.sid !== "string" ||
      claims.sid.length < 16 || claims.sid.length > 128 ||
      typeof claims.familyId !== "string" ||
      claims.familyId.length < 16 || claims.familyId.length > 128 ||
      typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat !== ACCESS_TOKEN_TTL_SECONDS
    ) return null;

    const config = configFor(claims.kind);
    if (claims.sub !== config.sub) return null;

    if (claims.kind === "platform") {
      if (
        typeof claims.userId !== "string" ||
        claims.userId.length < 1 ||
        typeof claims.email !== "string" ||
        claims.email.length < 3 ||
        claims.email.length > 320 ||
        claims.tenantId !== undefined ||
        claims.role !== undefined
      ) return null;
    } else {
      if (
        typeof claims.tenantId !== "string" ||
        claims.tenantId.length < 1 ||
        claims.tenantId.length > 128 ||
        typeof claims.role !== "string" ||
        claims.role.length < 1 ||
        claims.role.length > 64
      ) return null;
      if (claims.userId !== undefined && (typeof claims.userId !== "string" || claims.userId.length < 1 || claims.userId.length > 128)) return null;
      if (claims.email !== undefined && (typeof claims.email !== "string" || claims.email.length < 3 || claims.email.length > 320)) return null;
    }

    const expected = createHmac("sha256", getSecret()).update(`${headerPart}.${payloadPart}`).digest("base64url");
    if (!compareStringsSafe(signature, expected)) return null;
    return claims as SharedSessionClaims;
  } catch {
    return null;
  }
}

export function verifyAccessTokenSignature(
  token: string,
  expectedKinds: SessionKind | readonly SessionKind[],
): SharedSessionClaims | null {
  const claims = verifySignatureShape(token);
  if (!claims) return null;
  const allowed = Array.isArray(expectedKinds) ? expectedKinds : [expectedKinds];
  return allowed.includes(claims.kind) ? claims : null;
}

export async function verifyAccessToken(
  token: string,
  expectedKinds: SessionKind | readonly SessionKind[],
): Promise<SharedSessionClaims | null> {
  const claims = verifySignatureShape(token);
  if (!claims) return null;

  const allowed = Array.isArray(expectedKinds) ? expectedKinds : [expectedKinds];
  if (!allowed.includes(claims.kind)) return null;

  let nowMs: number;
  try {
    nowMs = await databaseNowMs();
  } catch {
    return null;
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.exp <= nowSec || claims.iat > nowSec + 60) return null;
  return claims;
}

function normalizeContext(context?: SessionRequestContext): SessionRequestContext {
  return {
    ipAddress: context?.ipAddress?.trim().slice(0, 128) || null,
    userAgent: context?.userAgent?.trim().slice(0, 1024) || null,
  };
}

function validatePrincipal(principal: SharedSessionPrincipal): void {
  if (principal.kind === "platform") {
    if (!principal.userId || !principal.email || principal.tenantId || principal.role) {
      throw new Error("Invalid platform session principal");
    }
    return;
  }
  if (!principal.tenantId || !principal.role) {
    throw new Error("Invalid tenant session principal");
  }
}

type SessionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function dbNowMsInTransaction(tx: SessionTx): Promise<number> {
  const result = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
  const raw = (result.rows[0] as { now_ms?: number | string } | undefined)?.now_ms;
  const nowMs = Number(raw);
  if (!Number.isFinite(nowMs)) throw new Error("Database clock is unavailable");
  return nowMs;
}

function makeClaims(
  principal: SharedSessionPrincipal,
  accessJti: string,
  refreshTokenId: string,
  familyId: string,
  nowSec: number,
): SharedSessionClaims {
  return {
    ver: ACCESS_TOKEN_VERSION,
    kind: principal.kind,
    jti: accessJti,
    sid: refreshTokenId,
    familyId,
    iat: nowSec,
    exp: nowSec + ACCESS_TOKEN_TTL_SECONDS,
    sub: configFor(principal.kind).sub,
    ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
    ...(principal.userId ? { userId: principal.userId } : {}),
    ...(principal.role ? { role: principal.role } : {}),
    ...(principal.email ? { email: principal.email } : {}),
  };
}

async function insertInitialPair(
  tx: SessionTx,
  principal: SharedSessionPrincipal,
  context?: SessionRequestContext,
): Promise<SessionPair> {
  validatePrincipal(principal);

  const nowMs = await dbNowMsInTransaction(tx);
  const nowSec = Math.floor(nowMs / 1000);
  const familyId = randomBytes(16).toString("hex");
  const refreshTokenId = randomBytes(16).toString("hex");
  const accessJti = randomBytes(16).toString("hex");
  const refreshToken = randomBytes(32).toString("base64url");
  const accessExpiresAt = new Date((nowSec + ACCESS_TOKEN_TTL_SECONDS) * 1000);
  const refreshExpiresAt = new Date(nowMs + REFRESH_FAMILY_TTL_MS);
  const normalized = normalizeContext(context);
  const accessToken = signAccessToken(makeClaims(principal, accessJti, refreshTokenId, familyId, nowSec));

  await tx.insert(refreshTokens).values({
    id: refreshTokenId,
    familyId,
    kind: principal.kind,
    tenantId: principal.tenantId ?? null,
    userId: principal.userId ?? null,
    role: principal.role ?? null,
    email: principal.email ?? null,
    tokenHash: hashRefreshToken(refreshToken),
    issuedAt: new Date(nowMs),
    familyCreatedAt: new Date(nowMs),
    expiresAt: refreshExpiresAt,
    ipAddress: normalized.ipAddress,
    userAgent: normalized.userAgent,
  });

  return { accessToken, accessJti, refreshToken, refreshTokenId, familyId, accessExpiresAt, refreshExpiresAt };
}

export async function issueSessionPair(
  principal: SharedSessionPrincipal,
  context?: SessionRequestContext,
): Promise<SessionPair> {
  return db.transaction((tx) => insertInitialPair(tx, principal, context));
}

export async function issueSessionPairInTransaction(
  tx: SessionTx,
  principal: SharedSessionPrincipal,
  context?: SessionRequestContext,
): Promise<SessionPair> {
  return insertInitialPair(tx, principal, context);
}

function parseTimestampMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const normalized = value.trim().replace(" ", "T");
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function rotateWithinFamily(
  tx: SessionTx,
  row: {
    familyId: string;
    kind: SessionKind;
    tenantId: string | null;
    userId: string | null;
    role: string | null;
    email: string | null;
    familyCreatedAt: Date | string;
  },
  context: SessionRequestContext | undefined,
  nowMs: number,
): Promise<SessionPair> {
  validatePrincipal({
    kind: row.kind,
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.role,
    email: row.email,
  });

  const nowSec = Math.floor(nowMs / 1000);
  const familyCreatedAtMs = parseTimestampMs(row.familyCreatedAt);
  if (familyCreatedAtMs === null) throw new Error("Invalid persisted refresh family timestamp");

  const refreshExpiresAt = new Date(familyCreatedAtMs + REFRESH_FAMILY_TTL_MS);
  if (refreshExpiresAt.getTime() <= nowMs) throw new Error("REFRESH_FAMILY_EXPIRED");

  const refreshTokenId = randomBytes(16).toString("hex");
  const accessJti = randomBytes(16).toString("hex");
  const refreshToken = randomBytes(32).toString("base64url");
  const normalized = normalizeContext(context);
  const accessToken = signAccessToken(
    makeClaims(
      {
        kind: row.kind,
        tenantId: row.tenantId,
        userId: row.userId,
        role: row.role,
        email: row.email,
      },
      accessJti,
      refreshTokenId,
      row.familyId,
      nowSec,
    ),
  );

  await tx.insert(refreshTokens).values({
    id: refreshTokenId,
    familyId: row.familyId,
    kind: row.kind,
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.role,
    email: row.email,
    tokenHash: hashRefreshToken(refreshToken),
    issuedAt: new Date(nowMs),
    familyCreatedAt: new Date(familyCreatedAtMs),
    expiresAt: refreshExpiresAt,
    ipAddress: normalized.ipAddress,
    userAgent: normalized.userAgent,
  });

  return {
    accessToken,
    accessJti,
    refreshToken,
    refreshTokenId,
    familyId: row.familyId,
    accessExpiresAt: new Date((nowSec + ACCESS_TOKEN_TTL_SECONDS) * 1000),
    refreshExpiresAt,
  };
}

export function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = rest.join("=").trim();
      if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
      return value || null;
    }
  }
  return null;
}

export function getAccessTokenFromRequest(req: Request, kind: SessionKind): string | null {
  const cookieToken = readCookie(req, configFor(kind).accessCookieName);
  if (cookieToken) return cookieToken;
  const authorization = req.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() || null : null;
}

export function getRefreshTokenFromRequest(req: Request, kind: SessionKind): string | null {
  if (req.headers.get("x-odoo-print-desktop") === "1") {
    const headerToken = req.headers.get("x-refresh-token")?.trim();
    if (headerToken) return headerToken;
  }
  return readCookie(req, configFor(kind).refreshCookieName);
}

export function accessCookieHeader(kind: SessionKind, token: string, expiresAt: Date): string {
  const config = configFor(kind);
  const secure = sessionCookieSecure() ? "; Secure" : "";
  return `${config.accessCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expiresAt.toUTCString()}; Max-Age=${ACCESS_TOKEN_TTL_SECONDS}`;
}

export function refreshCookieHeader(kind: SessionKind, token: string, expiresAt: Date): string {
  const config = configFor(kind);
  const secure = sessionCookieSecure() ? "; Secure" : "";
  return `${config.refreshCookieName}=${token}; Path=${config.refreshCookiePath}; HttpOnly; SameSite=Strict${secure}; Expires=${expiresAt.toUTCString()}; Max-Age=${REFRESH_FAMILY_TTL_MS / 1000}`;
}

export function clearAccessCookieHeader(kind: SessionKind): string {
  const config = configFor(kind);
  return `${config.accessCookieName}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

export function clearRefreshCookieHeader(kind: SessionKind): string {
  const config = configFor(kind);
  return `${config.refreshCookieName}=; Path=${config.refreshCookiePath}; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

export function sessionKindFromClaims(claims: SharedSessionClaims): SessionKind {
  return claims.kind;
}

export async function rotateRefreshToken(
  kind: SessionKind,
  token: string,
  context?: SessionRequestContext,
): Promise<RefreshResult> {
  const tokenHash = hashRefreshToken(token);

  const outcome = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT
        id,
        family_id AS "familyId",
        kind,
        tenant_id AS "tenantId",
        user_id AS "userId",
        role,
        email,
        family_created_at AS "familyCreatedAt",
        expires_at AS "expiresAt",
        revoked_at AS "revokedAt",
        revoked_reason AS "revokedReason",
        replaced_by AS "replacedBy",
        replaced_at AS "replacedAt"
      FROM refresh_tokens
      WHERE token_hash = ${tokenHash}
      FOR UPDATE
    `);

    const row = result.rows[0] as {
      id: string;
      familyId: string;
      kind: SessionKind;
      tenantId: string | null;
      userId: string | null;
      role: string | null;
      email: string | null;
      familyCreatedAt: Date | string;
      expiresAt: Date | string;
      revokedAt: Date | string | null;
      revokedReason: string | null;
      replacedBy: string | null;
      replacedAt: Date | string | null;
    } | undefined;

    if (!row || row.kind !== kind || row.revokedAt) return { status: "invalid" as const };

    const nowMs = await dbNowMsInTransaction(tx);
    const familyCreatedAtMs = parseTimestampMs(row.familyCreatedAt);
    const expiresAtMs = parseTimestampMs(row.expiresAt);
    if (familyCreatedAtMs === null || expiresAtMs === null) throw new Error("Invalid persisted refresh timestamp");

    if (nowMs >= familyCreatedAtMs + REFRESH_FAMILY_TTL_MS) {
      await tx.execute(sql`
        UPDATE refresh_tokens
        SET revoked_at = clock_timestamp(), revoked_reason = 'absolute_expired'
        WHERE family_id = ${row.familyId} AND revoked_at IS NULL
      `);
      return { status: "invalid" as const };
    }

    if (nowMs >= expiresAtMs) return { status: "invalid" as const };

    if (row.replacedBy) {
      const replacedAtMs = parseTimestampMs(row.replacedAt);
      if (replacedAtMs !== null && nowMs <= replacedAtMs + REFRESH_ROTATION_GRACE_MS) {
        try {
          const pair = await rotateWithinFamily(tx, row, context, nowMs);
          return { status: "rotated" as const, pair };
        } catch (error) {
          if (error instanceof Error && error.message === "REFRESH_FAMILY_EXPIRED") return { status: "invalid" as const };
          throw error;
        }
      }

      await tx.execute(sql`
        UPDATE refresh_tokens
        SET revoked_at = clock_timestamp(), revoked_reason = 'refresh_reuse_detected'
        WHERE family_id = ${row.familyId} AND revoked_at IS NULL
      `);

      try {
        const actorType = row.kind === "platform" ? "platform" : row.userId ? "user" : "system";
        await writeAuditEvent({
          tenantId: row.tenantId,
          actorType,
          actorId: row.userId ?? null,
          action: "auth.refresh.reuse_detected",
          resourceType: "refresh_token_family",
          resourceId: row.familyId,
          metadata: {
            refreshTokenId: row.id,
            revokedReason: "refresh_reuse_detected",
          },
        }, tx);
      } catch (auditError) {
        logError("auth.refresh.reuse_audit_failed", {
          familyId: row.familyId,
          error: auditError instanceof Error ? auditError.message : "unknown",
        });
      }

      return {
        status: "reused" as const,
        familyId: row.familyId,
        notificationEmail: row.email,
        tenantId: row.tenantId,
        userId: row.userId,
        kind: row.kind,
      };
    }

    try {
      const pair = await rotateWithinFamily(tx, row, context, nowMs);
      await tx.execute(sql`
        UPDATE refresh_tokens
        SET replaced_by = ${pair.refreshTokenId}, replaced_at = clock_timestamp()
        WHERE id = ${row.id}
      `);
      return { status: "rotated" as const, pair };
    } catch (error) {
      if (error instanceof Error && error.message === "REFRESH_FAMILY_EXPIRED") return { status: "invalid" as const };
      throw error;
    }
  });

  if (outcome.status === "reused") {
    if (outcome.notificationEmail) {
      try {
        await sendTransactionalEmail({
          to: outcome.notificationEmail,
          subject: "Yasser security alert: refresh token reuse detected",
          html: "<p>A refresh token reuse was detected on your Yasser session. All tokens in that session family were revoked. Sign in again to create a new session.</p>",
          text: "A refresh token reuse was detected on your Yasser session. All tokens in that session family were revoked. Sign in again to create a new session.",
        });
      } catch (error) {
        logError("auth.refresh.reuse_notification_failed", {
          familyId: outcome.familyId,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    } else {
      logWarn("auth.refresh.reuse_notification_unavailable", {
        familyId: outcome.familyId,
        reason: "no email address stored for session family",
      });
    }
  }

  return outcome;
}

export async function revokeSessionFamily(familyId: string, reason = "logout"): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(familyId)) throw new Error("Invalid session family id");
  await db.execute(sql`
    UPDATE refresh_tokens
    SET revoked_at = clock_timestamp(), revoked_reason = ${reason}
    WHERE family_id = ${familyId} AND revoked_at IS NULL
  `);
}

export async function cleanupExpiredRefreshTokens(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM refresh_tokens
    WHERE expires_at <= clock_timestamp()
    RETURNING id
  `);
  return result.rows.length;
}

export function getRefreshCookieName(kind: SessionKind): string {
  return configFor(kind).refreshCookieName;
}

export function getAccessCookieName(kind: SessionKind): string {
  return configFor(kind).accessCookieName;
}
