import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { getAgentHeartbeatFreshness, getEffectivePrinterStatus, getPrinterObservationFreshness } from "../../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../../lib/database-clock";
import { receiptRasterWidthDots } from "../../../../lib/receipt-width";
import { TenantSubscriptionRequiredError, requireTenantBillingAccess } from "../../../../lib/entitlements";
import { isVirtualPrinterRecord, isApprovedVirtualSpoolerTestRecord } from "../../../../lib/printer-virtual";
import { getSupportedDocumentTypes, type ProtocolType, type TransportType } from "../../../../lib/printer-capability";

export const dynamic = "force-dynamic";

/** Publish only document languages admitted by the Gateway's physical transport
 * validator. A TCP byte stream labelled "spooler" must not look like a
 * Windows driver, regardless of legacy supported_protocols metadata.
 * Keep raw capability JSON untrusted: malformed lists fail closed in the
 * shared validator rather than being interpreted as missing metadata.
 */
function odooPrinterCapabilities(value: unknown, connectionType: string, protocol: string) {
  const reported = value && typeof value === "object" && !Array.isArray(value)
    ? value as { supported_protocols?: string[] }
    : null;
  return {
    supported_protocols: getSupportedDocumentTypes(
      protocol.trim().toLowerCase() as ProtocolType,
      connectionType.trim().toLowerCase() as TransportType,
      reported,
    ),
  };
}

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

  const conditions = [eq(printers.lifecycle, "active"), eq(printers.inventoryPresent, true), eq(agents.lifecycle, "active"), eq(printers.tenantId, apiKey.tenantId), eq(agents.tenantId, apiKey.tenantId)];
  if (agentId) {
    conditions.push(eq(agents.id, agentId));
  }

  await refreshClockSkew();
  const now = gatewayNow();
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
      capabilities: printers.capabilities,
      config: printers.config,
      managementSource: printers.managementSource,
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
  return NextResponse.json({
    printers: rows.filter((row) => !isVirtualPrinterRecord(row) ||
      (row.managementSource === "manager" && isApprovedVirtualSpoolerTestRecord(row))).map((row) => ({
      id: row.id,
      name: row.name,
      reportedStatus: row.status,
      freshness: getPrinterObservationFreshness(row.lastSeenAt, now),
      lastSeenAt: row.lastSeenAt,
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
      capabilities: odooPrinterCapabilities(row.capabilities, row.connectionType, row.protocol),
      printableWidthDots: receiptRasterWidthDots(row.capabilities as Record<string, unknown> | null),
      agent: {
        id: row.agentId,
        name: row.agentName,
        reportedStatus: row.agentStatus,
        freshness: getAgentHeartbeatFreshness(row.agentLastSeenAt, now),
        lastSeenAt: row.agentLastSeenAt,
      },
    })),
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
