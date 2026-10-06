import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { getAgentHeartbeatFreshness, getEffectivePrinterStatus, getPrinterObservationFreshness } from "../../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../../lib/database-clock";
import { TenantSubscriptionRequiredError, requireTenantBillingAccess } from "../../../../lib/entitlements";

export const dynamic = "force-dynamic";

const ODOO_CAPABILITY_PROTOCOLS = new Set(["pdf", "image", "raw", "escpos", "zpl", "tspl", "spooler", "ipp", "ipps"]);

function odooPrinterCapabilities(value: unknown, connectionType: string, protocol: string) {
  const supported = new Set<string>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as { supported_protocols?: unknown }).supported_protocols;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item !== "string") continue;
        const normalized = item.trim().toLowerCase();
        if (ODOO_CAPABILITY_PROTOCOLS.has(normalized)) supported.add(normalized);
      }
    }
  }
  const conn = connectionType.trim().toLowerCase();
  const proto = protocol.trim().toLowerCase();
  // Backward compatibility: document capability belongs to the transport,
  // not to incidental discovery metadata. Old spooler rows with no capability
  // blob remain fully usable for ordinary driver-rendered printing.
  if (conn === "spooler" || proto === "spooler" || proto === "windows_spooler") {
    supported.add("pdf");
    supported.add("image");
  } else if (conn === "ipp" || conn === "ipps" || proto === "ipp" || proto === "ipps") {
    supported.add("pdf");
  }
  return { supported_protocols: [...supported] };
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
    printers: rows.map((row) => ({
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
