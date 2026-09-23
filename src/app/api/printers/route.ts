import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents, printers } from "../../../db/schema";
import { validateConsoleAuth } from "../../../lib/console-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "../../../lib/nanoid";
import { parsePrinterInput, validateConnectionConfig, validatePrinterTransportProtocol } from "../../../lib/printer-model";
import { writeAuditEvent } from "../../../lib/audit";
import { enforceTenantResourceEntitlement, TenantEntitlementError, isTenantBillingError } from "../../../lib/entitlements";
import { getEffectivePrinterStatus } from "../../../lib/agent-availability";
import { logError } from "../../../lib/log";

export const dynamic = "force-dynamic";
const MAX_PRINTERS_LIST = 1000;
const MAX_PRINTERS_OFFSET = 10_000;

export async function GET(req: Request) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
  const agentId = auth.kind === "agent" ? auth.agent.id : null;
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "printers.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }

  // Hard ceiling so cadence/abuse cannot force an unbounded scan. Entitlements
  // cap the row count per tenant (max_printers); 1000 is purely defensive.
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "1000", 10) || 1000, 1000);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10) || 0, 0);
  if (offset > MAX_PRINTERS_OFFSET) {
    return NextResponse.json({ error: `offset must be <= ${MAX_PRINTERS_OFFSET}` }, { status: 400 });
  }

  const rows = await db.select({ printer: printers, agent: agents })
    .from(printers)
    .leftJoin(agents, and(eq(agents.id, printers.agentId), eq(agents.tenantId, tenantId)))
    .where(agentId ? and(eq(printers.tenantId, tenantId), eq(printers.agentId, agentId)) : eq(printers.tenantId, tenantId))
    .orderBy(desc(printers.createdAt))
    .limit(limit)
    .offset(offset);
  const now = new Date();
  return NextResponse.json(rows.map(({ printer, agent }) => ({
    ...printer,
    status: getEffectivePrinterStatus(printer, agent, now),
    agentName: agent?.name ?? null,
    agentStatus: agent ? (agent.lifecycle === "active" && agent.status === "online" ? "online" : "offline") : "offline",
    agentLifecycle: agent?.lifecycle ?? null,
    agentLastSeenAt: agent?.lastSeenAt ?? null,
    configurationConverged: printer.managementSource === "manager"
      ? printer.appliedDesiredRevision >= printer.desiredRevision && printer.observedDesiredRevision >= printer.desiredRevision
      : true,
  })));
}

export async function POST(req: Request) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "printers.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  let data;
  try {
    data = parsePrinterInput(body);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Invalid printer configuration",
      code: "INVALID_PRINTER",
    }, { status: 400 });
  }

  try {
    const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
    if (auth.kind === "agent" && data.agentId !== auth.agent.id) {
      return NextResponse.json({ error: "Agent may only register printers for itself" }, { status: 403 });
    }

    let connectionType = data.connectionType;
    let protocol = data.protocol;
    const config = { ...data.config };
    if (connectionType === "usb" && typeof config.spooler_name === "string" && config.spooler_name.trim()) {
      connectionType = "spooler";
      protocol = "spooler";
      config.address = config.spooler_name.trim();
    }

    const transportProtocolError = validatePrinterTransportProtocol(connectionType, protocol);
    if (transportProtocolError) return NextResponse.json({ error: transportProtocolError }, { status: 400 });
    const error = validateConnectionConfig(connectionType, config, protocol);
    if (error) return NextResponse.json({ error }, { status: 400 });

    const id = data.id ?? `printer_${nanoid(8)}`;
    try {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('printers:' || ${tenantId}))`);
        const lockedAgent = await tx.execute(sql`SELECT lifecycle FROM agents WHERE id = ${data.agentId} AND tenant_id = ${tenantId} FOR UPDATE`);
        const agentLifecycle = (lockedAgent.rows[0] as { lifecycle?: string } | undefined)?.lifecycle;
        if (!agentLifecycle) throw new Error("agentId not found");
        if (agentLifecycle !== "active") throw new Error(`agent is ${agentLifecycle}`);
        await enforceTenantResourceEntitlement(tx, tenantId, "max_printers",
          sql`SELECT COUNT(*)::int AS count FROM printers WHERE tenant_id = ${tenantId} AND lifecycle <> 'retired'`);
        const inserted = await tx.insert(printers).values({
          id, tenantId: tenantId, agentId: data.agentId, name: data.name,
          printerType: data.printerType, deviceClass: data.deviceClass,
          connectionType, protocol,
          status: "unknown", lifecycle: "active", config,
          capabilities: null,
          managementSource: auth.kind === "manager" ? "manager" : "agent",
          desiredRevision: auth.kind === "manager" ? 1 : 0,
          appliedDesiredRevision: 0,
          observedDesiredRevision: 0,
          observedDeviceClass: null,
        }).returning();
        const created = inserted[0];
        await writeAuditEvent({
          tenantId: tenantId,
          actorType: auth.kind === "manager" && auth.claims.userId ? "user" : "system",
          actorId: auth.kind === "manager" ? (auth.claims.userId ?? "legacy-manager") : auth.agent.id,
          action: "printer.registered",
          resourceType: "printer",
          resourceId: created.id,
        }, tx);
        return created;
      });
      return NextResponse.json(row, { status: 201 });
    } catch (error) {
      if (error instanceof TenantEntitlementError) return NextResponse.json({ error: error.message, code: "MAX_PRINTERS_EXCEEDED", entitlement: error.entitlement, limit: error.limit, used: error.used, upgradeRequired: true }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
      if (isTenantBillingError(error)) return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
      if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });
      throw error;
    }
  } catch (error) {
    logError("printers.register.failed", { tenantId: auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
