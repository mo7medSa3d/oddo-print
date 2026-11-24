import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../../../db";
import { apiKeys, odooInstallations, plans, tenantSubscriptions, tenants } from "../../../../db/schema";
import {
  constantTimeSecretMatch,
  hashLicenseKey,
  issueLicenseBundle,
  revokeLicenseBundle,
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

const DEFAULT_GRACE_DAYS = 7;
const DEFAULT_FEATURES = ["direct_print", "ws_push"];
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
let validatedSigningKeyPem: string | null = null;

/**
 * Bind an Odoo database UUID to an active tenant license key and issue the
 * initial Ed25519-signed v2 license bundle.
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
      logError("license.activate_key_error", { error: error instanceof Error ? error.message : "unknown" });
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

  let body: { licenseKey?: unknown; tenantId?: unknown; odooDbUuid?: unknown; dbName?: unknown; prevRev?: unknown };
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
    body = parsed as { licenseKey?: unknown; tenantId?: unknown; odooDbUuid?: unknown; dbName?: unknown; prevRev?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON", code: "INVALID_REQUEST" },
      { status: 400, headers: HEADERS },
    );
  }

  const rawKey = bearer || (typeof body.licenseKey === "string" ? body.licenseKey.trim() : "");
  if (!rawKey) {
    logWarn("license.activate.denied", { reason: "missing_license_key" });
    return NextResponse.json(
      { error: "License key is required", code: "MISSING_LICENSE_KEY" },
      { status: 401, headers: HEADERS },
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

  const dbName = typeof body.dbName === "string" && body.dbName.trim()
    ? body.dbName.trim().slice(0, 120)
    : `Odoo DB ${odooDbUuid.slice(0, 8)}`;

  const refreshSecret = runtimeSecret("LICENSE_REFRESH_SECRET")?.trim() ?? "";
  const isMasterSecret = refreshSecret.length >= 32 && constantTimeSecretMatch(rawKey, refreshSecret);
  if (isMasterSecret && !requestedTenantId) {
    return NextResponse.json(
      { error: "tenantId is required", code: "INVALID_TENANT_ID" },
      { status: 400, headers: HEADERS },
    );
  }

  const clientIp = clientIpFrom(req);
  const rateBucket = `license:${hashLicenseKey(rawKey).slice(0, 32)}`;
  if (!isMasterSecret) {
    let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
    try {
      rate = await reserveAuthAttempt(clientIp, rateBucket, "license");
    } catch (error) {
      logError("auth.rate_limit.store_unavailable", { endpoint: "license_activate", error: error instanceof Error ? error.message : "unknown" });
      return NextResponse.json(
        { error: "Service temporarily unavailable", code: "SERVICE_UNAVAILABLE" },
        { status: 503, headers: HEADERS },
      );
    }
    if (!rate.allowed) {
      logWarn("license.activate.rate_limited", { retryAfterSec: rate.retryAfterSec });
      const res = setRateLimitHeaders(
        NextResponse.json(
          { error: "Too many activation attempts", code: "RATE_LIMITED", retryAfterSeconds: rate.retryAfterSec },
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
      if (!isMasterSecret) {
        const tokenHash = hashLicenseKey(rawKey);
        const [key] = await tx
          .select({
            tenantId: apiKeys.tenantId,
            revokedAt: apiKeys.revokedAt,
            readOnlyUntil: apiKeys.readOnlyUntil,
            odooEnabled: apiKeys.odooEnabled,
          })
          .from(apiKeys)
          .where(eq(apiKeys.hashedKey, tokenHash))
          .limit(1)
          .for("share");

        if (!key) {
          return { error: "Invalid license key", code: "INVALID_LICENSE_KEY", status: 401 as const, authValid: false };
        }
        if (key.revokedAt || key.readOnlyUntil) {
          return { error: "License key has been revoked", code: "LICENSE_KEY_REVOKED", status: 401 as const, authValid: false };
        }
        if (!key.odooEnabled) {
          return { error: "License key is not enabled for Odoo activation", code: "LICENSE_KEY_DISABLED", status: 403 as const, authValid: true };
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

      const [tenant] = await tx
        .select({ id: tenants.id, lifecycle: tenants.lifecycle })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .for("share");

      const [sub] = await tx
        .select()
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.tenantId, tenantId))
        .orderBy(desc(tenantSubscriptions.updatedAt))
        .limit(1)
        .for("share");

      const licenseId = sub?.internalReference || `lic_${tenantId}`;
      const planId = sub?.planId ?? "none";

      if (!tenant || tenant.lifecycle !== "active") {
        const bundle = revokeLicenseBundle(
          { license_id: licenseId, tenant_id: tenantId, odoo_db_uuid: odooDbUuid, plan: planId, key_id: keyId, prev_rev: prevRev, nowMs },
          privateKeyPem,
        );
        return { error: "Workspace is not active", code: "TENANT_SUSPENDED", status: 403 as const, bundle, serverTime, authValid: true };
      }

      if (!sub || sub.status !== "active" || sub.entitlementBlocked) {
        const bundle = revokeLicenseBundle(
          { license_id: licenseId, tenant_id: tenantId, odoo_db_uuid: odooDbUuid, plan: planId, key_id: keyId, prev_rev: prevRev, nowMs },
          privateKeyPem,
        );
        const isRevoked = Boolean(sub?.revokedAt);
        return {
          error: isRevoked ? "License revoked" : "No active subscription",
          code: isRevoked ? "LICENSE_REVOKED" : "NO_ACTIVE_SUBSCRIPTION",
          status: 403 as const,
          bundle,
          serverTime,
          authValid: true,
        };
      }

      const periodStart = sub.currentPeriodStart ? new Date(sub.currentPeriodStart) : null;
      const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
      if (
        !periodStart || !Number.isFinite(periodStart.getTime()) ||
        !periodEnd || !Number.isFinite(periodEnd.getTime()) ||
        periodStart.getTime() > nowMs
      ) {
        const bundle = revokeLicenseBundle(
          { license_id: licenseId, tenant_id: tenantId, odoo_db_uuid: odooDbUuid, plan: planId, key_id: keyId, prev_rev: prevRev, nowMs },
          privateKeyPem,
        );
        return { error: "No active subscription", code: "NO_ACTIVE_SUBSCRIPTION", status: 403 as const, bundle, serverTime, authValid: true };
      }
      if (periodEnd.getTime() <= nowMs) {
        const bundle = revokeLicenseBundle(
          { license_id: licenseId, tenant_id: tenantId, odoo_db_uuid: odooDbUuid, plan: planId, key_id: keyId, prev_rev: prevRev, nowMs },
          privateKeyPem,
        );
        return { error: "Subscription expired", code: "LICENSE_EXPIRED", status: 403 as const, bundle, serverTime, authValid: true };
      }

      const [plan] = await tx.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
      const planEntitlements = (plan?.entitlements ?? {}) as Record<string, unknown>;
      const parseLimit = (val: unknown, fallback: number): number => {
        if (typeof val === "number" && Number.isFinite(val)) {
          const floored = Math.floor(val);
          if (floored >= 1 && Number.isSafeInteger(floored)) return floored;
        }
        if (val === "unlimited") return 999;
        return fallback;
      };
      const maxAgents = parseLimit(planEntitlements.max_agents, 5);
      const maxPrinters = parseLimit(planEntitlements.max_printers, 15);
      const maxOdooDbs = parseLimit(planEntitlements.max_odoo_dbs, 1);

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"license-db-bind:" + tenantId}, 0))`);
      const bindingId = "db_" + crypto.createHash("sha256").update(`${tenantId}:${odooDbUuid}`).digest("hex").slice(0, 32);
      const activeDbBindings = await tx
        .select({ id: odooInstallations.id })
        .from(odooInstallations)
        .where(
          and(
            eq(odooInstallations.tenantId, tenantId),
            eq(odooInstallations.enabled, true),
            sql`left(${odooInstallations.id}, 3) = 'db_'`,
          ),
        );
      const alreadyBound = activeDbBindings.some((r) => r.id === bindingId);
      if (!alreadyBound) {
        if (activeDbBindings.length >= maxOdooDbs) {
          const bundle = revokeLicenseBundle(
            { license_id: licenseId, tenant_id: tenantId, odoo_db_uuid: odooDbUuid, plan: plan?.id ?? sub.planId, key_id: keyId, prev_rev: prevRev, nowMs },
            privateKeyPem,
          );
          return {
            error: "ODOO_DB_ALREADY_BOUND: This license is already bound to another Odoo database.",
            code: "ODOO_DB_ALREADY_BOUND",
            status: 403 as const,
            bundle,
            serverTime,
            authValid: true,
          };
        }
        await tx
          .insert(odooInstallations)
          .values({
            id: bindingId,
            tenantId,
            name: dbName,
            secretHash: crypto.createHash("sha256").update(`urn:odoo:db:${odooDbUuid}`).digest("hex"),
            enabled: true,
            disabledAt: null,
          })
          .onConflictDoUpdate({
            target: odooInstallations.id,
            set: { name: dbName, enabled: true, disabledAt: null },
          });
      }

      const bundle = issueLicenseBundle(
        {
          license_id: licenseId,
          tenant_id: tenantId,
          odoo_db_uuid: odooDbUuid,
          plan: plan?.id ?? sub.planId,
          key_id: keyId,
          max_agents: maxAgents,
          max_printers: maxPrinters,
          features: DEFAULT_FEATURES,
          issued_at: serverTime,
          expires_at: periodEnd.toISOString(),
          grace_days: DEFAULT_GRACE_DAYS,
          prev_rev: prevRev,
          nowMs,
        },
        privateKeyPem,
      );

      return {
        ok: true as const,
        activated: true,
        alreadyBound,
        bundle,
        serverTime,
        tenantId,
        plan: bundle.payload.plan,
        rev: bundle.payload.rev,
        authValid: true,
      };
    });

    if (!isMasterSecret && result.authValid) {
      await refundAuthReservation(clientIp, rateBucket, "license").catch(() => undefined);
    }

    if ("error" in result) {
      logWarn("license.activate.rejected", {
        status: result.status,
        code: result.code,
        reason: result.error,
      });
      return NextResponse.json(
        "bundle" in result && result.bundle
          ? { error: result.error, code: result.code, revoked: true, bundle: result.bundle, serverTime: result.serverTime }
          : { error: result.error, code: result.code },
        { status: result.status, headers: HEADERS },
      );
    }

    logInfo("license.activate.ok", {
      tenantId: result.tenantId,
      plan: result.plan,
      rev: result.rev,
      alreadyBound: result.alreadyBound,
      keyId,
    });
    return NextResponse.json(
      {
        ok: true,
        activated: true,
        alreadyBound: result.alreadyBound,
        bundle: result.bundle,
        serverTime: result.serverTime,
      },
      { status: 200, headers: HEADERS },
    );
  } catch (error) {
    logError("license.activate_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      { status: 500, headers: HEADERS },
    );
  }
}
