import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateConsoleAuth } from "../../../../lib/console-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { canTransitionLifecycle } from "../../../../lib/lifecycle";
import { PRINTER_TYPES, CONNECTION_TYPES, PRINTER_PROTOCOLS, assertPrinterMetadataLimits, validateConnectionConfig, validatePrinterTransportProtocol } from "../../../../lib/printer-model";
import { writeAuditEvent } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  printerType: z.enum(PRINTER_TYPES).optional(),
  deviceClass: z.enum(["thermal", "laser", "inkjet", "label", "other", "unknown"]).optional(),
  connectionType: z.enum(CONNECTION_TYPES).optional(),
  protocol: z.enum(PRINTER_PROTOCOLS).optional(),
  lifecycle: z.enum(["active", "disabled", "retired"]).optional(),
  config: z.object({
    ip: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    vid: z.number().int().min(0).max(65535).optional(),
    pid: z.number().int().min(0).max(65535).optional(),
    serial: z.string().max(255).optional(),
    address: z.string().max(512).optional(),
    spooler_name: z.string().max(255).optional(),
  }).strict().optional(),
}).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "printers.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }
  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
  const { id } = await params;
  const row = await db.query.printers.findFirst({
    where: auth.kind === "agent"
      ? and(eq(printers.id, id), eq(printers.tenantId, tenantId), eq(printers.agentId, auth.agent.id))
      : and(eq(printers.id, id), eq(printers.tenantId, tenantId)),
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Printer desired-state mutation is a manager control-plane operation.
  // Agents may observe/register their own printers, but must never mutate
  // manager-owned configuration or lifecycle through this route.
  if (auth.kind !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try { requireManagerPermission(auth.claims, "printers.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const tenantId = auth.claims.tenantId;
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body && typeof body === "object" && ("branchId" in body || "branch_id" in body || "enabled" in body || "type" in body || "status" in body || "capabilities" in body)) {
    return NextResponse.json({ error: "Unsupported legacy/observed field" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try { assertPrinterMetadataLimits({ config: parsed.data.config ?? {} }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "printer metadata exceeds limits" }, { status: 400 }); }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('printer:' || ${tenantId} || ':' || ${id}))`);

    const existing = await tx.query.printers.findFirst({
      where: auth.kind === "agent"
        ? and(eq(printers.id, id), eq(printers.tenantId, tenantId), eq(printers.agentId, auth.agent.id))
        : and(eq(printers.id, id), eq(printers.tenantId, tenantId)),
    });
    if (!existing) return { kind: "not_found" as const };

    if (parsed.data.lifecycle && !canTransitionLifecycle(existing.lifecycle, parsed.data.lifecycle)) {
      return { kind: "conflict" as const, message: `invalid lifecycle transition: ${existing.lifecycle} -> ${parsed.data.lifecycle}` };
    }

    if (parsed.data.lifecycle === "active") {
      const lockedAgent = await tx.execute(sql`SELECT lifecycle FROM agents WHERE id = ${existing.agentId} AND tenant_id = ${tenantId} FOR UPDATE`);
      const ownerLifecycle = (lockedAgent.rows[0] as { lifecycle?: string } | undefined)?.lifecycle;
      if (!ownerLifecycle) return { kind: "error" as const, message: "Printer owner agent missing" };
      if (ownerLifecycle !== "active") return { kind: "conflict" as const, message: `cannot activate printer while agent is ${ownerLifecycle}` };
    }

    let connectionType = parsed.data.connectionType ?? existing.connectionType;
    let protocol = parsed.data.protocol ?? existing.protocol;
    const cfg = (parsed.data.config ?? existing.config ?? {}) as Record<string, unknown>;
    if (connectionType === "usb" && typeof cfg.spooler_name === "string" && cfg.spooler_name.trim()) {
      connectionType = "spooler";
      protocol = "spooler";
    }
    if (
      parsed.data.connectionType !== undefined ||
      parsed.data.protocol !== undefined ||
      parsed.data.config !== undefined
    ) {
      const transportProtocolError = validatePrinterTransportProtocol(connectionType, protocol);
      if (transportProtocolError) {
        return { kind: "invalid" as const, message: transportProtocolError };
      }
      const err = validateConnectionConfig(connectionType, cfg, protocol);
      if (err) return { kind: "invalid" as const, message: err };
    }

    const desiredStateChanged =
      parsed.data.name !== undefined ||
      parsed.data.printerType !== undefined ||
      parsed.data.deviceClass !== undefined ||
      parsed.data.connectionType !== undefined ||
      parsed.data.protocol !== undefined ||
      parsed.data.config !== undefined ||
      parsed.data.lifecycle !== undefined;

    const update: Partial<typeof printers.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.printerType !== undefined) update.printerType = parsed.data.printerType;
    if (parsed.data.deviceClass !== undefined) update.deviceClass = parsed.data.deviceClass;
    if (parsed.data.connectionType !== undefined || connectionType !== existing.connectionType) update.connectionType = connectionType;
    if (parsed.data.protocol !== undefined || protocol !== existing.protocol) update.protocol = protocol;
    if (parsed.data.config !== undefined) update.config = parsed.data.config;
    if (parsed.data.lifecycle !== undefined) update.lifecycle = parsed.data.lifecycle;

    const setValues = desiredStateChanged
      ? {
          ...update,
          managementSource: "manager" as const,
          desiredRevision: sql<number>`${printers.desiredRevision} + 1`,
        }
      : update;

    const [row] = await tx.update(printers)
      .set(setValues)
      .where(and(eq(printers.id, id), eq(printers.tenantId, tenantId)))
      .returning();

    await writeAuditEvent({
      tenantId: tenantId,
      actorType: auth.kind === "manager" && auth.claims.userId ? "user" : "system",
      actorId: auth.kind === "manager" ? (auth.claims.userId ?? "legacy-manager") : auth.agent.id,
      action: "printer.changed",
      resourceType: "printer",
      resourceId: id,
      metadata: {
        managementSource: row.managementSource,
        desiredStateChanged,
        desiredRevision: row.desiredRevision,
        lifecycle: row.lifecycle,
      },
    }, tx);

    return { kind: "ok" as const, row };
  });

  if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (result.kind === "conflict") return NextResponse.json({ error: result.message }, { status: 409 });
  if (result.kind === "invalid") return NextResponse.json({ error: result.message }, { status: 400 });
  if (result.kind === "error") return NextResponse.json({ error: result.message }, { status: 500 });
  return NextResponse.json(result.row);
}
