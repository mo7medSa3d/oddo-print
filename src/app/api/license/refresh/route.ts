import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { db } from "../../../../db";
import { apiKeys, odooInstallations, plans, tenantSubscriptions, tenants } from "../../../../db/schema";
import {
  constantTimeSecretMatch,
  hashLicenseKey,
  issueLicenseBundle,
  revokeLicenseBundle,
  type LicenseClaimsV2,
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

const DEFAULT_GRACE_DAYS = 7;
const DEFAULT_FEATURES = ["direct_print", "ws_push"];
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
let validatedSigningKeyPem: string | null = null;

/** Delegates to shared revokeLicenseBundle (signs a v2 status: "revoked" tombstone). */
function buildRevocationTombstone(params: {
  licenseId: string;
  tenantId: string;
  odooDbUuid: string;
  plan: string;
  keyId: string;
  now: Date;
  prevRev?: number;
  privateKeyPem: string;
}): SignedLicenseBundle<LicenseClaimsV2> {
  return revokeLicenseBundle(
    {
      license_id: params.licenseId,
      tenant_id: params.tenantId,
      odoo_db_uuid: params.odooDbUuid,
      plan: params.plan,
      key_id: params.keyId,
      prev_rev: params.prevRev,
      nowMs: params.now.getTime(),
    },
    params.privateKeyPem,
  );
}

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
      logError("license.refresh_key_error", { error: error instanceof Error ? error.message : "unknown" });
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
  if (!bearer) {
    logWarn("license.refresh.denied", { reason: "missing_bearer" });
    return NextResponse.json(
      { error: "Unauthorized", code: "MISSING_LICENSE_KEY" },
      { status: 401, headers: HEADERS },
    );
  }

  let body: { tenantId?: unknown; odooDbUuid?: unknown; prevRev?: unknown };
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
    body = parsed as { tenantId?: unknown; odooDbUuid?: unknown; prevRev?: unknown };
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

  const refreshSecret = runtimeSecret("LICENSE_REFRESH_SECRET")?.trim() ?? "";
  const isMasterSecret = refreshSecret.length >= 32 && constantTimeSecretMatch(bearer, refreshSecret);
  if (isMasterSecret && !requestedTenantId) {
    return NextResponse.json(
      { error: "tenantId is required", code: "INVALID_TENANT_ID" },
      { status: 400, headers: HEADERS },
    );
  }

  const clientIp = clientIpFrom(req);
  const rateBucket = `license:${hashLicenseKey(bearer).slice(0, 32)}`;
  if (!isMasterSecret) {
    let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
    try {
      rate = await reserveAuthAttempt(clientIp, rateBucket, "license");
    } catch (error) {
      logError("auth.rate_limit.store_unavailable", { endpoint: "license_refresh", error: error instanceof Error ? error.message : "unknown" });
      return NextResponse.json(
        { error: "Service temporarily unavailable", code: "SERVICE_UNAVAILABLE" },
        { status: 503, headers: HEADERS },
      );
    }
    if (!rate.allowed) {
      logWarn("license.refresh.rate_limited", { retryAfterSec: rate.retryAfterSec });
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
      if (!isMasterSecret) {
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
      const now = new Date(nowMs);

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

      // Issue signed revocation tombstones so Odoo/Agent revoke locally instead of riding out a stale grace window.
      if (!tenant || tenant.lifecycle !== "active") {
        const tombstone = buildRevocationTombstone({
          licenseId,
          tenantId,
          odooDbUuid,
          plan: planId,
          keyId,
          now,
          prevRev,
          privateKeyPem,
        });
        return { error: "Workspace is not active", code: "TENANT_SUSPENDED", status: 403 as const, bundle: tombstone, authValid: true };
      }

      if (!sub || sub.status !== "active" || sub.entitlementBlocked) {
        const tombstone = buildRevocationTombstone({
          licenseId,
          tenantId,
          odooDbUuid,
          plan: planId,
          keyId,
          now,
          prevRev,
          privateKeyPem,
        });
        const isRevoked = Boolean(sub?.revokedAt);
        return {
          error: isRevoked ? "License revoked" : "No active subscription",
          code: isRevoked ? "LICENSE_REVOKED" : "NO_ACTIVE_SUBSCRIPTION",
          status: 403 as const,
          bundle: tombstone,
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
        const tombstone = buildRevocationTombstone({
          licenseId,
          tenantId,
          odooDbUuid,
          plan: planId,
          keyId,
          now,
          prevRev,
          privateKeyPem,
        });
        return { error: "No active subscription", code: "NO_ACTIVE_SUBSCRIPTION", status: 403 as const, bundle: tombstone, authValid: true };
      }
      if (periodEnd.getTime() <= nowMs) {
        const tombstone = buildRevocationTombstone({
          licenseId,
          tenantId,
          odooDbUuid,
          plan: planId,
          keyId,
          now,
          prevRev,
          privateKeyPem,
        });
        return { error: "Subscription expired", code: "LICENSE_EXPIRED", status: 403 as const, bundle: tombstone, authValid: true };
      }

      const [plan] = await tx.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
      const graceUntil = new Date(periodEnd.getTime() + DEFAULT_GRACE_DAYS * 86400_000);

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

      // Enforce per-tenant Odoo DB binding lock using isolated `db_<hash>` rows
      // so legacy `/api/odoo/installations` records never collide with license slots.
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
          const tombstone = buildRevocationTombstone({
            licenseId,
            tenantId,
            odooDbUuid,
            plan: plan?.id ?? sub.planId,
            keyId,
            now,
            prevRev,
            privateKeyPem,
          });
          return {
            error: "ODOO_DB_ALREADY_BOUND: This license is already bound to another Odoo database.",
            code: "ODOO_DB_ALREADY_BOUND",
            status: 403 as const,
            bundle: tombstone,
            authValid: true,
          };
        }
        await tx
          .insert(odooInstallations)
          .values({
            id: bindingId,
            tenantId,
            name: `Odoo DB ${odooDbUuid.slice(0, 8)}`,
            secretHash: crypto.createHash("sha256").update(`urn:odoo:db:${odooDbUuid}`).digest("hex"),
            enabled: true,
            disabledAt: null,
          })
          .onConflictDoUpdate({
            target: odooInstallations.id,
            set: { enabled: true, disabledAt: null },
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
          issued_at: now.toISOString(),
          expires_at: periodEnd.toISOString(),
          grace_until: graceUntil.toISOString(),
          prev_rev: prevRev,
          nowMs,
        },
        privateKeyPem,
      );
      return { ok: true as const, bundle, tenantId, plan: bundle.payload.plan, rev: bundle.payload.rev, authValid: true };
    });

    if (!isMasterSecret && result.authValid) {
      await refundAuthReservation(clientIp, rateBucket, "license").catch(() => undefined);
    }

    if ("error" in result) {
      if ("bundle" in result && result.bundle) {
        logWarn("license.refresh.revoked", {
          tenantId: result.bundle.payload.tenant_id,
          reason: result.error,
          code: result.code,
          odooDbUuidPrefix: odooDbUuid.slice(0, 8),
        });
      } else {
        logWarn("license.refresh.denied", { status: result.status, reason: result.error, code: result.code });
      }
      return NextResponse.json(
        "bundle" in result && result.bundle
          ? { error: result.error, code: result.code, revoked: true, bundle: result.bundle }
          : { error: result.error, code: result.code },
        { status: result.status, headers: HEADERS },
      );
    }
    logInfo("license.refresh.issued", {
      tenantId: result.tenantId,
      plan: result.plan,
      rev: result.rev,
      keyId,
    });
    return NextResponse.json({ ok: true, bundle: result.bundle }, { status: 200, headers: HEADERS });
  } catch (error) {
    logError("license.refresh_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      { status: 500, headers: HEADERS },
    );
  }
}
