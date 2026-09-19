import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../../../db";
import { tenants } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { writeAuditEvent } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

/**
 * Gateway-side read for operators.
 * The activation state shown here is a replicated Odoo business setting,
 * not the tenant lifecycle and not the API-key credential lifecycle.
 */
export async function GET(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    requireManagerPermission(manager, "integrations.read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, manager.tenantId),
    columns: {
      odooEnabled: true,
      odooEnabledRevision: true,
      odooEnabledUpdatedAt: true,
    },
  });
  if (!tenant) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  return NextResponse.json({
    enabled: tenant.odooEnabled,
    revision: tenant.odooEnabledRevision,
    updatedAt: tenant.odooEnabledUpdatedAt,
  }, {
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
  const apiKey = await validateOdooKey(req);
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const now = new Date();
  const updated = await db.update(tenants)
    .set({
      odooEnabled: enabled,
      odooEnabledRevision: Number(revision),
      odooEnabledUpdatedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(tenants.id, apiKey.tenantId),
      lt(tenants.odooEnabledRevision, Number(revision)),
    ))
    .returning({
      enabled: tenants.odooEnabled,
      revision: tenants.odooEnabledRevision,
      updatedAt: tenants.odooEnabledUpdatedAt,
    });

  if (updated.length) {
    await writeAuditEvent({
      tenantId: apiKey.tenantId,
      actorType: "odoo",
      actorId: apiKey.id,
      action: "odoo.gateway_configuration.updated",
      resourceType: "tenant",
      resourceId: apiKey.tenantId,
      metadata: { enabled, revision: Number(revision) },
    });
    return NextResponse.json({ ok: true, applied: true, ...updated[0] }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const current = await db.query.tenants.findFirst({
    where: eq(tenants.id, apiKey.tenantId),
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
