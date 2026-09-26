import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { getEffectivePrinterStatus } from "../../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../../lib/database-clock";
import { TenantSubscriptionRequiredError, requireTenantBillingAccess } from "../../../../lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req, { requireIntegrationEnabled: false });
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Printer inventory is an Odoo runtime-control-plane surface. Do not expose
  // tenant printer identities after subscription access has ended; use the same
  // database-authoritative predicate as print admission and agent discovery.
  try {
    await requireTenantBillingAccess(db, apiKey.tenantId);
  } catch (error) {
    if (error instanceof TenantSubscriptionRequiredError) {
      return NextResponse.json(
        { error: error.message, code: "SUBSCRIPTION_REQUIRED" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agent_id")?.trim();

  const conditions = [eq(printers.lifecycle, "active"), eq(agents.lifecycle, "active"), eq(printers.tenantId, apiKey.tenantId), eq(agents.tenantId, apiKey.tenantId)];
  if (agentId) {
    conditions.push(eq(agents.id, agentId));
  }

  const rows = await db
    .select({
      id: printers.id,
      name: printers.name,
      status: printers.status,
      lifecycle: printers.lifecycle,
      lastSeenAt: printers.lastSeenAt,
      printerType: printers.printerType,
      deviceClass: printers.deviceClass,
      connectionType: printers.connectionType,
      protocol: printers.protocol,
      agentId: agents.id,
      agentName: agents.name,
      agentStatus: agents.status,
      agentLifecycle: agents.lifecycle,
      agentLastSeenAt: agents.lastSeenAt,
    })
    .from(printers)
    .innerJoin(agents, and(eq(printers.agentId, agents.id), eq(printers.tenantId, agents.tenantId)))
    .where(and(...conditions))
    .orderBy(printers.name);

  await refreshClockSkew();
  const now = gatewayNow();
  return NextResponse.json({
    printers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: getEffectivePrinterStatus(
        { lifecycle: row.lifecycle, status: row.status, lastSeenAt: row.lastSeenAt },
        { lifecycle: row.agentLifecycle, status: row.agentStatus, lastSeenAt: row.agentLastSeenAt },
        now,
      ),
      lifecycle: row.lifecycle,
      printerType: row.printerType,
      deviceClass: row.deviceClass,
      connectionType: row.connectionType,
      protocol: row.protocol,
      agent: { id: row.agentId, name: row.agentName },
    })),
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
