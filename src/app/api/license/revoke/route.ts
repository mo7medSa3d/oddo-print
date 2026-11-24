import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { db } from "../../../../db";
import { apiKeys, odooInstallations, tenantSubscriptions } from "../../../../db/schema";
import {
  constantTimeSecretMatch,
  hashLicenseKey,
  revokeLicenseBundle,
} from "../../../../lib/license-signer";
import {
  requirePlatformActorInTransaction,
  validatePlatformOwner,
  PlatformMutationAuthorityChangedError,
  PlatformUnauthorizedError,
} from "../../../../lib/platform-auth";
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
let validatedSigningKeyPem: string | null = null;

/**
 * Issue a signed Ed25519 v2 revocation tombstone with a strictly higher `rev`
 * and optionally unbind the Odoo DB installation so older bundles are
 * immediately invalidated both online and offline.
 */
export async function POST(req: Request) {
  const privateKeyPem = runtimeSecret("LICENSE_SIGNING_PRIVATE_KEY_PEM");
  if (!privateKeyPem) {
    return NextResponse.json(
      { error: "License signing is not configured", code: "LICENSE_SIGNING_UNCONFIGURED" },
      { status: 503, headers: HEADERS },
    );
  }
  if (privateKeyPem !== validatedSigningKeyPem) {
    try {
      const signingKey = crypto.createPrivateKey(privateKeyPem);
      if (signingKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Ed25519 private key required");
      }
      validatedSigningKeyPem = privateKeyPem;
    } catch (error) {
      logError("license.revoke_key_error", { error: error instanceof Error ? error.message : "unknown" });
      return NextResponse.json(
        { error: "License signing is not configured", code: "LICENSE_SIGNING_UNCONFIGURED" },
        { status: 503, headers: HEADERS },
      );
    }
  }

  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json(
      { error: "Request body too large", code: "REQUEST_BODY_TOO_LARGE" },
      { status: 413, headers: HEADERS },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const platformActor = !bearer ? await validatePlatformOwner(req) : null;
  if (!bearer && !platformActor) {
    logWarn("license.revoke.denied", { reason: "missing_credentials" });
    return NextResponse.json(
      { error: "Unauthorized", code: "MISSING_LICENSE_KEY" },
      { status: 401, headers: HEADERS },
    );
  }

  let body: { tenantId?: unknown; odooDbUuid?: unknown; prevRev?: unknown; unbindDb?: unknown };
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
    body = parsed as { tenantId?: unknown; odooDbUuid?: unknown; prevRev?: unknown; unbindDb?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON", code: "INVALID_REQUEST" },
      { status: 400, headers: HEADERS },
    );
  }

  const odooDbUuid = typeof body.odooDbUuid === "string" ? body.odooDbUuid.trim() : "";
  if (!odooDbUuid || odooDbUuid.length > 128) {
    return NextResponse.json(
      { error: "odooDbUuid is required", code: "INVALID_ODOO_DB_UUID" },
      { status: 400, headers: HEADERS },
    );
  }

  const requestedTenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (body.tenantId !== undefined && (!requestedTenantId || requestedTenantId.length > 128)) {
    return NextResponse.json(
      { error: "tenantId is invalid", code: "INVALID_TENANT_ID" },
      { status: 400, headers: HEADERS },
    );
  }

  let prevRev = 0;
  if (body.prevRev !== undefined) {
    if (typeof body.prevRev !== "number" || !Number.isSafeInteger(body.prevRev) || body.prevRev < 0) {
      return NextResponse.json(
        { error: "prevRev is invalid", code: "INVALID_REQUEST" },
        { status: 400, headers: HEADERS },
      );
    }
    prevRev = body.prevRev;
  }

  const unbindDb = body.unbindDb !== false;
  const refreshSecret = runtimeSecret("LICENSE_REFRESH_SECRET")?.trim() ?? "";
  const isMasterSecret = Boolean(bearer) && refreshSecret.length >= 32 && constantTimeSecretMatch(bearer, refreshSecret);
  if ((isMasterSecret || platformActor) && !requestedTenantId) {
    return NextResponse.json(
      { error: "tenantId is required", code: "INVALID_TENANT_ID" },
      { status: 400, headers: HEADERS },
    );
  }

  const clientIp = clientIpFrom(req);
  const rateBucket = bearer ? `license:${hashLicenseKey(bearer).slice(0, 32)}` : "";
  if (bearer && !isMasterSecret) {
    let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
    try {
      rate = await reserveAuthAttempt(clientIp, rateBucket, "license");
    } catch (error) {
      logError("auth.rate_limit.store_unavailable", { endpoint: "license_revoke", error: error instanceof Error ? error.message : "unknown" });
      return NextResponse.json(
        { error: "Service temporarily unavailable", code: "SERVICE_UNAVAILABLE" },
        { status: 503, headers: HEADERS },
      );
    }
    if (!rate.allowed) {
      logWarn("license.revoke.rate_limited", { retryAfterSec: rate.retryAfterSec });
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

  const keyId = (runtimeSecret("LICENSE_SIGNING_KEY_ID") ?? "k1").trim() || "k1";

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '3000ms'`);

      let tenantId = requestedTenantId;
      if (platformActor) {
        await requirePlatformActorInTransaction(tx, platformActor);
      } else if (!isMasterSecret) {
        const tokenHash = hashLicenseKey(bearer);
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
          return { error: "Unauthorized", code: "INVALID_LICENSE_KEY", status: 401 as const, authValid: false };
        }
        if (requestedTenantId && requestedTenantId !== key.tenantId) {
          return { error: "Tenant mismatch", code: "TENANT_MISMATCH", status: 403 as const, authValid: true };
        }
        tenantId = key.tenantId;
      }

      const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
      const nowMs = Number((clock.rows[0] as { now_ms?: number | string } | undefined)?.now_ms);
      if (!Number.isFinite(nowMs)) {
        throw new Error("Database clock is unavailable");
      }
      const serverTime = new Date(nowMs).toISOString();

      const [sub] = await tx
        .select()
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.tenantId, tenantId))
        .orderBy(desc(tenantSubscriptions.updatedAt))
        .limit(1)
        .for("share");

      const licenseId = sub?.internalReference || `lic_${tenantId}`;
      const planId = sub?.planId ?? "none";

      let unbound = false;
      if (unbindDb) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"license-db-bind:" + tenantId}, 0))`);
        const bindingId = "db_" + crypto.createHash("sha256").update(`${tenantId}:${odooDbUuid}`).digest("hex").slice(0, 32);
        const updated = await tx
          .update(odooInstallations)
          .set({ enabled: false, disabledAt: new Date(nowMs) })
          .where(and(
            eq(odooInstallations.tenantId, tenantId),
            eq(odooInstallations.id, bindingId),
            eq(odooInstallations.enabled, true),
          ))
          .returning({ id: odooInstallations.id });
        unbound = updated.length > 0;
      }

      const bundle = revokeLicenseBundle(
        {
          license_id: licenseId,
          tenant_id: tenantId,
          odoo_db_uuid: odooDbUuid,
          plan: planId,
          key_id: keyId,
          prev_rev: prevRev,
          nowMs,
        },
        privateKeyPem,
      );

      return {
        ok: true as const,
        revoked: true,
        unbound,
        bundle,
        serverTime,
        tenantId,
        rev: bundle.payload.rev,
        authValid: true,
      };
    });

    if (bearer && !isMasterSecret && result.authValid) {
      await refundAuthReservation(clientIp, rateBucket, "license").catch(() => undefined);
    }

    if ("error" in result) {
      logWarn("license.revoke.denied", { status: result.status, code: result.code, reason: result.error });
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status, headers: HEADERS },
      );
    }

    logInfo("license.revoke.issued", {
      tenantId: result.tenantId,
      rev: result.rev,
      unbound: result.unbound,
      keyId,
    });
    return NextResponse.json(
      {
        ok: true,
        revoked: true,
        unbound: result.unbound,
        bundle: result.bundle,
        serverTime: result.serverTime,
      },
      { status: 200, headers: HEADERS },
    );
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError || error instanceof PlatformMutationAuthorityChangedError) {
      return NextResponse.json(
        { error: error.message, code: "UNAUTHORIZED" },
        { status: 401, headers: HEADERS },
      );
    }
    logError("license.revoke_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      { status: 500, headers: HEADERS },
    );
  }
}
