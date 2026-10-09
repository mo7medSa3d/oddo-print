import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "../../../db";
import { agents, printers } from "../../../db/schema";
import { validateConsoleAuth } from "../../../lib/console-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../lib/manager-mutation-authorization";
import { requireActiveTenantInTransaction } from "../../../lib/tenant-guard";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { clampListLimit } from "../../../lib/request-limits";
import { fleetCursorIdHeaders, readFleetCursorId } from "../../../lib/fleet-cursor";
import { nanoid } from "../../../lib/nanoid";
import { parsePrinterInput, validateConnectionConfig, validatePrinterTransportProtocol } from "../../../lib/printer-model";
import { writeAuditEvent } from "../../../lib/audit";
import { enforceTenantResourceEntitlement, TenantEntitlementError, isTenantBillingError } from "../../../lib/entitlements";
import { agentStaleThresholdSeconds, getAgentHeartbeatFreshness, getEffectiveAgentStatus, getEffectivePrinterStatus, getPrinterObservationFreshness } from "../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../lib/database-clock";
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

  // Per-request transport bound, not a product cardinality cap. Plans may
  // explicitly allow unlimited printers; callers must paginate rather than infer a fleet limit.
  const { searchParams } = new URL(req.url);
  const limit = clampListLimit(searchParams.get("limit"), 1000, MAX_PRINTERS_LIST);
  const offsetRaw = parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);
  if (offset > MAX_PRINTERS_OFFSET) {
    return NextResponse.json({ error: `offset must be <= ${MAX_PRINTERS_OFFSET}; use beforeCreatedAt + beforeId keyset pagination for deeper fleets` }, { status: 400 });
  }
  const beforeCreatedAtRaw = searchParams.get("beforeCreatedAt");
  let beforeId: string | null;
  try { beforeId = readFleetCursorId(searchParams); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid fleet cursor" }, { status: 400 }); }
  if ((beforeCreatedAtRaw == null) !== (beforeId == null)) {
    return NextResponse.json({ error: "beforeCreatedAt and beforeId must be provided together" }, { status: 400 });
  }
  const beforeCreatedAt = beforeCreatedAtRaw == null ? null : new Date(beforeCreatedAtRaw);
  if (beforeCreatedAt && Number.isNaN(beforeCreatedAt.getTime())) {
    return NextResponse.json({ error: "beforeCreatedAt must be a valid timestamp" }, { status: 400 });
  }
  if (beforeCreatedAt && offset !== 0) {
    return NextResponse.json({ error: "offset cannot be combined with keyset pagination" }, { status: 400 });
  }

  await refreshClockSkew();
  const now = gatewayNow();
  const agentFreshnessThresholdSeconds = agentStaleThresholdSeconds();
  const ownershipWhere = agentId
    ? and(eq(printers.tenantId, tenantId), eq(printers.agentId, agentId))
    : eq(printers.tenantId, tenantId);
  const cursorWhere = beforeCreatedAt && beforeId
    ? or(lt(printers.createdAt, beforeCreatedAt), and(eq(printers.createdAt, beforeCreatedAt), lt(printers.id, beforeId)))
    : undefined;
  const where = cursorWhere ? and(ownershipWhere, cursorWhere) : ownershipWhere;
  const rows = await db.select({ printer: printers, agent: agents })
    .from(printers)
    .leftJoin(agents, and(eq(agents.id, printers.agentId), eq(agents.tenantId, tenantId)))
    .where(where)
    .orderBy(desc(printers.createdAt), desc(printers.id))
    .limit(limit + 1)
    .offset(beforeCreatedAt ? 0 : offset);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const responseRows = pageRows.map(({ printer, agent }) => ({
    ...printer,
    reportedStatus: printer.status,
    freshness: getPrinterObservationFreshness(printer.lastSeenAt, now),
    status: getEffectivePrinterStatus(printer, agent, now),
    agentName: agent?.name ?? null,
    // Presentation must preserve freshness uncertainty. Routing has its own
    // availability gate; a stale/missing Agent is unknown here, not Offline.
    agentReportedStatus: agent?.status ?? null,
    agentFreshness: getAgentHeartbeatFreshness(agent?.lastSeenAt ?? null, now),
    agentStatus: agent ? getEffectiveAgentStatus(agent, now) : "unknown",
    agentLifecycle: agent?.lifecycle ?? null,
    agentLastSeenAt: agent?.lastSeenAt ?? null,
    agentStaleThresholdSeconds: agentFreshnessThresholdSeconds,
    configurationConverged: printer.managementSource === "manager"
      ? printer.appliedDesiredRevision >= printer.desiredRevision && printer.observedDesiredRevision >= printer.desiredRevision
      : true,
  }));
  const last = pageRows[pageRows.length - 1]?.printer;
  return NextResponse.json(responseRows, {
    headers: {
      "Cache-Control": "no-store",
      "X-Has-More": hasMore ? "true" : "false",
      ...(hasMore && last ? {
        "X-Next-Before-Created-At": last.createdAt.toISOString(),
        ...fleetCursorIdHeaders(last.id),
      } : {}),
    },
  });
}

export async function POST(req: Request) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "printers.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }

  let body: unknown;
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

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

    // A *paired* Agent may explicitly enable testing for its OWN locally
    // installed software spooler. This is not Manager authentication and
    // never grants Agent credentials permission to edit other printers.
    // The resulting Gateway desired state remains unverified until the Agent
    // service independently enumerates and validates that Windows queue.
    const virtualTest = config.virtual_spooler_test === true;
    const virtualSpoolerName = typeof config.spooler_name === "string" ? config.spooler_name.trim() : "";
    const prohibitedSoftwareQueue = /fax|redirected| in session |citrix|thinprint|remote desktop|vmware|yaseir_virtual_test_capture/i.test(virtualSpoolerName);
    if (virtualTest && (data.printerType !== "virtual" ||
        connectionType !== "spooler" || protocol !== "spooler" ||
        !virtualSpoolerName || config.passthrough_protocols?.length ||
        prohibitedSoftwareQueue)) {
      return NextResponse.json({ error: "Virtual test requires a local Windows software spooler queue, without redirected/FAX/capture queues or RAW passthrough", code: "INVALID_VIRTUAL_TEST" }, { status: 400 });
    }
    if (auth.kind === "manager" && data.printerType === "virtual" && !virtualTest) {
      return NextResponse.json({ error: "Virtual printer registration requires explicit test opt-in", code: "INVALID_VIRTUAL_TEST" }, { status: 400 });
    }
    const transportProtocolError = validatePrinterTransportProtocol(connectionType, protocol);
    if (transportProtocolError) return NextResponse.json({ error: transportProtocolError }, { status: 400 });
    const error = validateConnectionConfig(connectionType, config, protocol);
    if (error) return NextResponse.json({ error }, { status: 400 });

    // An Agent cannot choose arbitrary printer IDs for a virtual test. A
    // stable per-tenant/Agent/queue ID makes ambiguous double-click/retry
    // registration conflict rather than creating two destinations.
    const id = virtualTest && auth.kind === "agent"
      ? "printer_vt_" + createHash("sha256").update(JSON.stringify([tenantId, auth.agent.id, virtualSpoolerName.toLowerCase()])).digest("hex").slice(0, 24)
      : data.id ?? `printer_${nanoid(8)}`;
    try {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('printers:' || ${tenantId}))`);
        const lockedAgent = await tx.execute(sql`SELECT lifecycle FROM agents WHERE id = ${data.agentId} AND tenant_id = ${tenantId} FOR UPDATE`);
        const agentLifecycle = (lockedAgent.rows[0] as { lifecycle?: string } | undefined)?.lifecycle;
        if (!agentLifecycle) throw new Error("agentId not found");
        if (agentLifecycle !== "active") throw new Error(`agent is ${agentLifecycle}`);
        if (auth.kind === "manager") {
          await requireActiveTenantInTransaction(tx, tenantId);
          await requireManagerActorInTransaction(tx, auth.claims, "printers.manage");
        }
        await enforceTenantResourceEntitlement(tx, tenantId, "max_printers",
          sql`SELECT COUNT(*)::int AS count FROM printers WHERE tenant_id = ${tenantId} AND lifecycle <> 'retired' AND (management_source <> 'agent' OR inventory_present = true)`);
        const inserted = await tx.insert(printers).values({
          id, tenantId: tenantId, agentId: data.agentId, name: data.name,
          printerType: data.printerType, deviceClass: data.deviceClass,
          connectionType, protocol,
          status: "unknown", lifecycle: "active", config,
          capabilities: null,
          // Gateway-owned desired state is necessary for the Windows Agent
          // to receive and verify the opt-in, irrespective of who paired it.
          // "manager" here is the existing control-plane ownership type,
          // NOT a requirement for desktop Manager user credentials.
          managementSource: auth.kind === "manager" || virtualTest ? "manager" : "agent",
          desiredRevision: auth.kind === "manager" || virtualTest ? 1 : 0,
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
      if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
      if (error instanceof TenantEntitlementError) return NextResponse.json({ error: error.message, code: "MAX_PRINTERS_EXCEEDED", entitlement: error.entitlement, limit: error.limit, used: error.used, upgradeRequired: true }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
      if (isTenantBillingError(error)) return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
      if (error instanceof Error && error.message === "agentId not found") return NextResponse.json({ error: "Agent is not paired with this Gateway workspace", code: "AGENT_NOT_FOUND" }, { status: 404 });
      if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });
      throw error;
    }
  } catch (error) {
    logError("printers.register.failed", { tenantId: auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
