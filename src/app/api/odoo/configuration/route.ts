import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../../../db";
import { apiKeys, tenantSubscriptions } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { writeAuditEvent } from "../../../../lib/audit";
import { isBillingAccessStatus, isSubscriptionPeriodLive } from "../../../../lib/entitlements";
import { refreshClockSkew } from "../../../../lib/database-clock";

export const dynamic = "force-dynamic";

/**
 * Gateway-side read for operators.
 * The activation state shown here is a replicated Odoo business setting,
 * scoped independently to each Odoo integration API key; it is not tenant lifecycle.
 */
export async function GET(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    requireManagerPermission(manager, "integrations.read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const integrations = await db.query.apiKeys.findMany({
    where: eq(apiKeys.tenantId, manager.tenantId),
    columns: {
      id: true,
      name: true,
      odooEnabled: true,
      odooEnabledRevision: true,
      odooEnabledUpdatedAt: true,
      revokedAt: true,
    },
  });

  return NextResponse.json({ integrations }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Odoo is the source of truth for the integration activation checkbox.
 * A monotonic revision prevents an older in-flight request from restoring
 * a stale state after a newer toggle has already reached the Gateway.
 */
export async function PATCH(req: Request) {
  const apiKey = await validateOdooKey(req, { requireIntegrationEnabled: false });
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiKey.readOnly) {
    return NextResponse.json(
      {
        error: "API key is in its rotation grace period and is read-only.",
        code: "API_KEY_READ_ONLY",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const enabled = record.enabled;
  const revision = record.revision;

  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    return NextResponse.json({ error: "revision must be a non-negative integer" }, { status: 400 });
  }

  // Enabling Gateway printing creates a billable/executable runtime state and
  // therefore requires a live subscription. Disabling must remain possible
  // even after expiry/cancellation so Odoo can converge the replicated state
  // to a safe OFF value.
  if (enabled) {
    // The gate compares a Stripe/DB period end against the calibrated Gateway clock.
    await refreshClockSkew();
    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, apiKey.tenantId),
      columns: { status: true, currentPeriodEnd: true },
    });
    if (!sub || !isBillingAccessStatus(sub.status) || !isSubscriptionPeriodLive(sub.currentPeriodEnd)) {
      return NextResponse.json(
        { error: "An active subscription is required to enable Gateway printing. Choose a plan in Billing first.", code: "SUBSCRIPTION_REQUIRED" },
        { status: 403 },
      );
    }
  }

  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const result = await tx.update(apiKeys)
      .set({
        odooEnabled: enabled,
        odooEnabledRevision: Number(revision),
        odooEnabledUpdatedAt: now,
      })
      .where(and(
        eq(apiKeys.id, apiKey.id),
        eq(apiKeys.tenantId, apiKey.tenantId),
        lt(apiKeys.odooEnabledRevision, Number(revision)),
      ))
      .returning({
        enabled: apiKeys.odooEnabled,
        revision: apiKeys.odooEnabledRevision,
        updatedAt: apiKeys.odooEnabledUpdatedAt,
      });

    if (result.length) {
      await writeAuditEvent({
        tenantId: apiKey.tenantId,
        actorType: "odoo",
        actorId: apiKey.id,
        action: "odoo.gateway_configuration.updated",
        resourceType: "api_key",
        resourceId: apiKey.id,
        metadata: { enabled, revision: Number(revision) },
      }, tx);
    }
    return result;
  });

  if (updated.length) {
    return NextResponse.json({ ok: true, applied: true, ...updated[0] }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const current = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.id, apiKey.id), eq(apiKeys.tenantId, apiKey.tenantId)),
    columns: {
      odooEnabled: true,
      odooEnabledRevision: true,
      odooEnabledUpdatedAt: true,
    },
  });
  if (!current) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  if (Number(revision) < current.odooEnabledRevision) {
    return NextResponse.json({
      ok: true,
      applied: false,
      reason: "stale_revision",
      enabled: current.odooEnabled,
      revision: current.odooEnabledRevision,
      updatedAt: current.odooEnabledUpdatedAt,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (current.odooEnabled === enabled) {
    return NextResponse.json({
      ok: true,
      applied: false,
      reason: "already_current",
      enabled: current.odooEnabled,
      revision: current.odooEnabledRevision,
      updatedAt: current.odooEnabledUpdatedAt,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.json({
    error: "Conflicting Odoo gateway activation update for the same revision",
    current: {
      enabled: current.odooEnabled,
      revision: current.odooEnabledRevision,
      updatedAt: current.odooEnabledUpdatedAt,
    },
  }, { status: 409 });
}
