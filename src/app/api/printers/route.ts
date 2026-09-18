import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents, printers } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "../../../lib/nanoid";
import { parsePrinterInput, validateConnectionConfig } from "../../../lib/printer-model";
import { writeAuditEvent } from "../../../lib/audit";
import { enforceTenantResourceEntitlement, TenantEntitlementError, TenantSubscriptionRequiredError, TenantEntitlementConfigError } from "../../../lib/entitlements";
import { getEffectivePrinterStatus } from "../../../lib/agent-availability";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const rows = await db.select({ printer: printers, agent: agents })
    .from(printers)
    .leftJoin(agents, and(eq(agents.id, printers.agentId), eq(agents.tenantId, claims.tenantId)))
    .where(eq(printers.tenantId, claims.tenantId))
    .orderBy(desc(printers.createdAt));
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
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  try {
    const data = parsePrinterInput(body);

    const error = validateConnectionConfig(data.connectionType, data.config);
    if (error) return NextResponse.json({ error }, { status: 400 });

    const id = data.id ?? `printer_${nanoid(8)}`;
    try {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('printers:' || ${claims.tenantId}))`);
        const lockedAgent = await tx.execute(sql`SELECT lifecycle FROM agents WHERE id = ${data.agentId} AND tenant_id = ${claims.tenantId} FOR UPDATE`);
        const agentLifecycle = (lockedAgent.rows[0] as { lifecycle?: string } | undefined)?.lifecycle;
        if (!agentLifecycle) throw new Error("agentId not found");
        if (agentLifecycle !== "active") throw new Error(`agent is ${agentLifecycle}`);
        await enforceTenantResourceEntitlement(tx, claims.tenantId, "max_printers",
          sql`SELECT COUNT(*)::int AS count FROM printers WHERE tenant_id = ${claims.tenantId} AND lifecycle <> 'retired'`);
        const inserted = await tx.insert(printers).values({
          id, tenantId: claims.tenantId, agentId: data.agentId, name: data.name,
          printerType: data.printerType, deviceClass: data.deviceClass,
          connectionType: data.connectionType, protocol: data.protocol,
          status: "unknown", lifecycle: "active", config: data.config,
          capabilities: null,
          managementSource: "manager",
          desiredRevision: 1,
          appliedDesiredRevision: 0,
          observedDesiredRevision: 0,
          observedDeviceClass: null,
        }).returning();
        const created = inserted[0];
        await writeAuditEvent({
          tenantId: claims.tenantId,
          actorType: claims.userId ? "user" : "system",
          actorId: claims.userId ?? "legacy-manager",
          action: "printer.registered",
          resourceType: "printer",
          resourceId: created.id,
        }, tx);
        return created;
      });
      return NextResponse.json(row, { status: 201 });
    } catch (error) {
      if (error instanceof TenantEntitlementError) return NextResponse.json({ error: error.message, code: error.code }, { status: 429, headers: { "Retry-After": "60" } });
      if (error instanceof TenantSubscriptionRequiredError || error instanceof TenantEntitlementConfigError) return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
      if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });
      throw error;
    }
  } catch {
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
