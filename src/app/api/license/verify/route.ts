import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { db } from "../../../../db";
import { apiKeys, odooInstallations, tenantSubscriptions, tenants } from "../../../../db/schema";
import {
  constantTimeSecretMatch,
  hashLicenseKey,
  licenseReasonToErrorCode,
  verifyLicenseBundle,
  type SignedLicenseBundle,
} from "../../../../lib/license-signer";
import {
  clientIpFrom,
  refundAuthReservation,
  reserveAuthAttempt,
  setRateLimitHeaders,
} from "../../../../lib/auth-rate-limit";
import { logError, logInfo, logWarn } from "../../../../lib/log";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

let cachedPublicKey: { raw: string; pem: string } | null = null;

function resolvePublicKeyPem(): string | null {
  const explicitPub = runtimeSecret("LICENSE_SIGNING_PUBLIC_KEY_PEM");
  if (explicitPub) {
    if (cachedPublicKey?.raw === explicitPub) return cachedPublicKey.pem;
    const pubKey = crypto.createPublicKey(explicitPub);
    if (pubKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Ed25519 public key required");
    }
    const pem = pubKey.export({ type: "spki", format: "pem" }).toString();
    cachedPublicKey = { raw: explicitPub, pem };
    return pem;
  }
  const privateKeyPem = runtimeSecret("LICENSE_SIGNING_PRIVATE_KEY_PEM");
  if (!privateKeyPem) return null;
  if (cachedPublicKey?.raw === privateKeyPem) return cachedPublicKey.pem;
  const pubKey = crypto.createPublicKey(privateKeyPem);
  if (pubKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Ed25519 key required");
  }
  const pem = pubKey.export({ type: "spki", format: "pem" }).toString();
  cachedPublicKey = { raw: privateKeyPem, pem };
  return pem;
}

export async function POST(req: Request) {
  let publicKeyPem: string | null;
  try {
    publicKeyPem = resolvePublicKeyPem();
  } catch (error) {
    logError("license.verify_key_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "License verification is not configured", code: "LICENSE_VERIFY_UNCONFIGURED" },
      { status: 503, headers: HEADERS },
    );
  }
  if (!publicKeyPem) {
    return NextResponse.json(
      { error: "License verification is not configured", code: "LICENSE_VERIFY_UNCONFIGURED" },
      { status: 503, headers: HEADERS },
    );
  }

  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json(
      { error: "Request body too large", code: "REQUEST_BODY_TOO_LARGE" },
      { status: 413, headers: HEADERS },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) {
    logWarn("license.verify.denied", { reason: "missing_bearer" });
    return NextResponse.json(
      { error: "Unauthorized", code: "MISSING_LICENSE_KEY" },
      { status: 401, headers: HEADERS },
    );
  }

  let body: { bundle?: unknown; odooDbUuid?: unknown; minRev?: unknown };
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
      return NextResponse.json(
        { error: "Request body too large", code: "REQUEST_BODY_TOO_LARGE" },
        { status: 413, headers: HEADERS },
      );
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON object required");
    }
    body = parsed as { bundle?: unknown; odooDbUuid?: unknown; minRev?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON", code: "INVALID_REQUEST" },
      { status: 400, headers: HEADERS },
    );
  }

  if (!body.bundle || typeof body.bundle !== "object" || Array.isArray(body.bundle)) {
    return NextResponse.json(
      { error: "bundle is required", code: "INVALID_BUNDLE" },
      { status: 400, headers: HEADERS },
    );
  }

  let expectedDbUuid: string | undefined;
  if (body.odooDbUuid !== undefined) {
    if (typeof body.odooDbUuid !== "string" || !body.odooDbUuid.trim() || body.odooDbUuid.trim().length > 128) {
      return NextResponse.json(
        { error: "odooDbUuid is invalid", code: "INVALID_ODOO_DB_UUID" },
        { status: 400, headers: HEADERS },
      );
    }
    expectedDbUuid = body.odooDbUuid.trim();
  }

  let minRev: number | undefined;
  if (body.minRev !== undefined) {
    if (typeof body.minRev !== "number" || !Number.isSafeInteger(body.minRev) || body.minRev < 0) {
      return NextResponse.json(
        { error: "minRev is invalid", code: "INVALID_REQUEST" },
        { status: 400, headers: HEADERS },
      );
    }
    minRev = body.minRev;
  }

  const refreshSecret = runtimeSecret("LICENSE_REFRESH_SECRET")?.trim() ?? "";
  const isMasterSecret = refreshSecret.length >= 32 && constantTimeSecretMatch(bearer, refreshSecret);

  const clientIp = clientIpFrom(req);
  const rateBucket = `license:${hashLicenseKey(bearer).slice(0, 32)}`;
  if (!isMasterSecret) {
    let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
    try {
      rate = await reserveAuthAttempt(clientIp, rateBucket, "license");
    } catch (error) {
      logError("auth.rate_limit.store_unavailable", { endpoint: "license_verify", error: error instanceof Error ? error.message : "unknown" });
      return NextResponse.json(
        { error: "Service temporarily unavailable", code: "SERVICE_UNAVAILABLE" },
        { status: 503, headers: HEADERS },
      );
    }
    if (!rate.allowed) {
      logWarn("license.verify.rate_limited", { retryAfterSec: rate.retryAfterSec });
      const res = setRateLimitHeaders(
        NextResponse.json(
          { error: "Too many license requests", code: "RATE_LIMITED", retryAfterSeconds: rate.retryAfterSec },
          { status: 429, headers: HEADERS },
        ),
        rate,
      );
      if (rate.retryAfterSec) res.headers.set("Retry-After", String(rate.retryAfterSec));
      return res;
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '3000ms'`);
      let callerTenantId: string | null = null;
      if (!isMasterSecret) {
        const tokenHash = crypto.createHash("sha256").update(bearer, "utf8").digest("hex");
        const [key] = await tx
          .select({ tenantId: apiKeys.tenantId })
          .from(apiKeys)
          .where(and(
            eq(apiKeys.hashedKey, tokenHash),
            isNull(apiKeys.revokedAt),
            isNull(apiKeys.readOnlyUntil),
            eq(apiKeys.odooEnabled, true),
          ))
          .limit(1)
          .for("share");
        if (!key) {
          return {
            status: 401 as const,
            authValid: false,
            body: { error: "Unauthorized", code: "INVALID_LICENSE_KEY" },
          };
        }
        callerTenantId = key.tenantId;
      }

      const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
      const nowMs = Number((clock.rows[0] as { now_ms?: number | string } | undefined)?.now_ms);
      if (!Number.isFinite(nowMs)) {
        throw new Error("Database clock is unavailable");
      }
      const serverTime = new Date(nowMs).toISOString();

      // Reject cross-tenant bundles before verification so a tenant API key cannot probe
      // another tenant's revocation, expiry, or DB UUID status.
      const rawPayload = (body.bundle as { payload?: unknown }).payload;
      if (
        callerTenantId &&
        rawPayload &&
        typeof rawPayload === "object" &&
        !Array.isArray(rawPayload) &&
        typeof (rawPayload as { tenant_id?: unknown }).tenant_id === "string" &&
        (rawPayload as { tenant_id: string }).tenant_id !== callerTenantId
      ) {
        return {
          status: 403 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: false,
            inGrace: false,
            reason: "tenant_mismatch",
            code: "TENANT_MISMATCH",
            error: "Tenant mismatch",
            serverTime,
          },
        };
      }

      const verified = verifyLicenseBundle(
        body.bundle as SignedLicenseBundle,
        publicKeyPem,
        { expectedDbUuid, minRev },
        nowMs,
      );
      if (!verified.ok) {
        return {
          status: 200 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: verified.reason === "license_revoked",
            inGrace: false,
            reason: verified.reason,
            code: licenseReasonToErrorCode(verified.reason),
            serverTime,
          },
        };
      }

      if (callerTenantId && verified.claims.tenant_id !== callerTenantId) {
        return {
          status: 403 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: false,
            inGrace: false,
            reason: "tenant_mismatch",
            code: "TENANT_MISMATCH",
            error: "Tenant mismatch",
            serverTime,
          },
        };
      }

      const [tenant] = await tx
        .select({ id: tenants.id, lifecycle: tenants.lifecycle })
        .from(tenants)
        .where(eq(tenants.id, verified.claims.tenant_id))
        .limit(1)
        .for("share");

      if (!tenant || tenant.lifecycle !== "active") {
        return {
          status: 200 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: true,
            inGrace: false,
            reason: "workspace_not_active",
            code: "TENANT_SUSPENDED",
            claims: verified.claims,
            serverTime,
          },
        };
      }

      const [sub] = await tx
        .select()
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.tenantId, verified.claims.tenant_id))
        .orderBy(desc(tenantSubscriptions.updatedAt))
        .limit(1)
        .for("share");

      if (!sub || sub.status !== "active" || sub.entitlementBlocked) {
        const isRevoked = Boolean(sub?.revokedAt);
        return {
          status: 200 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: true,
            inGrace: false,
            reason: isRevoked ? "license_revoked" : "no_active_subscription",
            code: isRevoked ? "LICENSE_REVOKED" : "NO_ACTIVE_SUBSCRIPTION",
            claims: verified.claims,
            serverTime,
          },
        };
      }

      const periodStart = sub.currentPeriodStart ? new Date(sub.currentPeriodStart) : null;
      const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
      if (
        !periodStart || !Number.isFinite(periodStart.getTime()) ||
        !periodEnd || !Number.isFinite(periodEnd.getTime()) ||
        periodStart.getTime() > nowMs
      ) {
        return {
          status: 200 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: true,
            inGrace: false,
            reason: "no_active_subscription",
            code: "NO_ACTIVE_SUBSCRIPTION",
            claims: verified.claims,
            serverTime,
          },
        };
      }
      if (periodEnd.getTime() <= nowMs) {
        return {
          status: 200 as const,
          authValid: true,
          body: {
            valid: false,
            revoked: true,
            inGrace: false,
            reason: "subscription_expired",
            code: "LICENSE_EXPIRED",
            claims: verified.claims,
            serverTime,
          },
        };
      }

      if (verified.claims.odoo_db_uuid) {
        const bindingId = "db_" + crypto.createHash("sha256")
          .update(`${verified.claims.tenant_id}:${verified.claims.odoo_db_uuid}`)
          .digest("hex")
          .slice(0, 32);
        const [binding] = await tx
          .select({ enabled: odooInstallations.enabled })
          .from(odooInstallations)
          .where(and(
            eq(odooInstallations.tenantId, verified.claims.tenant_id),
            eq(odooInstallations.id, bindingId),
          ))
          .limit(1)
          .for("share");
        if (binding && !binding.enabled) {
          return {
            status: 200 as const,
            authValid: true,
            body: {
              valid: false,
              revoked: true,
              inGrace: false,
              reason: "odoo_db_unbound",
              code: "ODOO_DB_UNBOUND",
              claims: verified.claims,
              serverTime,
            },
          };
        }
      }

      return {
        status: 200 as const,
        authValid: true,
        body: {
          valid: true,
          revoked: false,
          inGrace: verified.inGrace,
          claims: verified.claims,
          serverTime,
        },
      };
    });

    if (!isMasterSecret && result.authValid) {
      await refundAuthReservation(clientIp, rateBucket, "license").catch(() => undefined);
    }

    if (result.status !== 200) {
      logWarn("license.verify.denied", {
        status: result.status,
        reason: "reason" in result.body ? result.body.reason : result.body.error,
        code: "code" in result.body ? result.body.code : undefined,
      });
    } else if ("valid" in result.body && result.body.valid && result.body.claims) {
      logInfo("license.verify.ok", {
        tenantId: result.body.claims.tenant_id,
        inGrace: result.body.inGrace,
      });
    } else if ("reason" in result.body) {
      logWarn("license.verify.rejected", {
        reason: result.body.reason,
        code: "code" in result.body ? result.body.code : undefined,
        revoked: result.body.revoked,
        tenantId: "claims" in result.body && result.body.claims ? result.body.claims.tenant_id : undefined,
      });
    }
    return NextResponse.json(result.body, { status: result.status, headers: HEADERS });
  } catch (error) {
    logError("license.verify_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      { status: 500, headers: HEADERS },
    );
  }
}
