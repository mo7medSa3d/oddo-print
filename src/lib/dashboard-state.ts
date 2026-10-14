import { db } from "../db";
import { agents, printers, printJobs } from "../db/schema";
import { and, count, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { agentStaleThresholdSeconds, getEffectiveAgentStatus, printerStaleThresholdSeconds } from "./agent-availability";
import { gatewayNow } from "./database-clock";
import { nonVirtualPrinterPredicate } from "./printer-virtual-sql";

export const DASHBOARD_FLEET_PAGE_SIZE = 100;
export const DASHBOARD_FLEET_SEARCH_MAX_LENGTH = 64;

export const DASHBOARD_PRINTER_FILTER_STATUSES = [
  "all",
  "ready",
  "printing",
  "attention",
  "unavailable",
  "saved",
  "online",
  "busy",
  "offline",
  "error",
  "unknown",
  "stale",
  "disabled",
  "retired",
] as const;

export type DashboardPrinterFilterStatus = (typeof DASHBOARD_PRINTER_FILTER_STATUSES)[number];

export type DashboardFleetOptions = {
  agentOffset?: number;
  printerOffset?: number;
  printerSearch?: string;
  printerStatus?: DashboardPrinterFilterStatus | string;
};

function safeOffset(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? (value as number) : 0;
}

function normalizedPrinterStatus(value: string | undefined): DashboardPrinterFilterStatus {
  const normalized = (value ?? "all").trim().toLowerCase();
  return (DASHBOARD_PRINTER_FILTER_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as DashboardPrinterFilterStatus)
    : "all";
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function printerFilterConditions(
  tenantId: string,
  options: DashboardFleetOptions,
  now: Date,
): SQL[] {
  const conditions: SQL[] = [eq(printers.tenantId, tenantId), eq(printers.sharedWithGateway, true), nonVirtualPrinterPredicate()];
  const search = options.printerSearch?.trim() ?? "";
  if (search.length >= 2 && search.length <= DASHBOARD_FLEET_SEARCH_MAX_LENGTH) {
    const term = `%${escapeLike(search.toLowerCase())}%`;
    conditions.push(
      or(
        sql`LOWER(${printers.name}) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(${printers.id}) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(${printers.connectionType}) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${printers.config}->>'spooler_name', '')) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${printers.config}->>'address', '')) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${printers.config}->>'ip', '')) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(${agents.name}) LIKE ${term} ESCAPE '\\'`
      )!
    );
  }

  const status = normalizedPrinterStatus(options.printerStatus);
  if (status === "saved") {
    conditions.push(or(eq(printers.inventoryPresent, false), sql`${printers.lifecycle} <> 'active'`)!);
    return conditions;
  }
  if (status === "all" || ["ready", "printing", "attention", "unavailable"].includes(status)) {
    conditions.push(eq(printers.inventoryPresent, true), eq(printers.lifecycle, "active"));
    if (status === "all") return conditions;
    const printerCutoff = new Date(now.getTime() - printerStaleThresholdSeconds() * 1000);
    const agentCutoff = new Date(now.getTime() - agentStaleThresholdSeconds() * 1000);
    const presentation = sql`CASE
      WHEN NOT COALESCE(${agents.lifecycle} = 'active' AND ${agents.status} = 'online'
        AND ${agents.lastSeenAt} >= ${agentCutoff} AND ${agents.lastSeenAt} <= ${now}, false) THEN 'unavailable'
      WHEN NOT COALESCE(${printers.lastSeenAt} >= ${printerCutoff} AND ${printers.lastSeenAt} <= ${now}, false) THEN 'unavailable'
      WHEN ${printers.status} = 'online' THEN 'ready'
      WHEN ${printers.status} = 'busy' THEN 'printing'
      WHEN ${printers.status} IN ('offline', 'error') THEN 'attention'
      ELSE 'unavailable' END`;
    conditions.push(sql`${presentation} = ${status}`);
    return conditions;
  }
  if (status === "disabled" || status === "retired") {
    conditions.push(eq(printers.lifecycle, status));
    return conditions;
  }

  const cutoff = new Date(now.getTime() - printerStaleThresholdSeconds() * 1000);
  const freshEvidence = sql`${printers.lastSeenAt} IS NOT NULL AND ${printers.lastSeenAt} >= ${cutoff} AND ${printers.lastSeenAt} <= ${now}`;
  const staleEvidence = sql`${printers.lastSeenAt} IS NOT NULL AND (${printers.lastSeenAt} < ${cutoff} OR ${printers.lastSeenAt} > ${now})`;
  conditions.push(eq(printers.lifecycle, "active"));
  if (status === "stale") {
    conditions.push(staleEvidence);
  } else if (status === "unknown") {
    conditions.push(
      or(
        sql`${printers.lastSeenAt} IS NULL`,
        and(freshEvidence, eq(printers.status, "unknown"))!
      )!
    );
  } else {
    conditions.push(freshEvidence, eq(printers.status, status));
  }
  return conditions;
}

export async function loadDashboardStateForTenant(
  tenantId: string,
  options: DashboardFleetOptions = {},
) {
  const now = gatewayNow();
  const staleThresholdSeconds = agentStaleThresholdSeconds();
  const agentOffset = safeOffset(options.agentOffset);
  const printerOffset = safeOffset(options.printerOffset);
  const printerConditions = printerFilterConditions(tenantId, options, now);

  const [agentRows, printerRows, allJobs, agentSummaryRows, printerSummaryRows] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        pairingCode: sql<string | null>`NULL`,
        pairingCodeExpiresAt: agents.pairingCodeExpiresAt,
        status: agents.status,
        lifecycle: agents.lifecycle,
        metadata: agents.metadata,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
        printerCount: count(printers.id),
        currentPrinterCount: sql<number>`COUNT(*) FILTER (WHERE ${printers.lifecycle} = 'active' AND ${printers.inventoryPresent} = true AND ${nonVirtualPrinterPredicate()})`,
      })
      .from(agents)
      .leftJoin(printers, and(eq(printers.agentId, agents.id), eq(printers.tenantId, tenantId), eq(printers.sharedWithGateway, true)))
      .where(eq(agents.tenantId, tenantId))
      .groupBy(agents.id)
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(DASHBOARD_FLEET_PAGE_SIZE + 1)
      .offset(agentOffset),
    db
      .select({
        id: printers.id,
        agentId: printers.agentId,
        agentName: agents.name,
        agentStatus: agents.status,
        agentLifecycle: agents.lifecycle,
        agentLastSeenAt: agents.lastSeenAt,
        inventoryPresent: printers.inventoryPresent,
        sharedWithGateway: printers.sharedWithGateway,
        name: printers.name,
        printerType: printers.printerType,
        deviceClass: printers.deviceClass,
        connectionType: printers.connectionType,
        protocol: printers.protocol,
        lifecycle: printers.lifecycle,
        status: printers.status,
        config: printers.config,
        capabilities: printers.capabilities,
        lastSeenAt: printers.lastSeenAt,
      })
      .from(printers)
      .leftJoin(agents, and(eq(agents.id, printers.agentId), eq(agents.tenantId, tenantId)))
      .where(and(...printerConditions)!)
      .orderBy(desc(printers.createdAt), desc(printers.id))
      .limit(DASHBOARD_FLEET_PAGE_SIZE + 1)
      .offset(printerOffset),
    db
      .select({
        id: printJobs.id,
        tenantId: printJobs.tenantId,
        destination: printJobs.destination,
        documentType: printJobs.documentType,
        agentId: printJobs.agentId,
        agentName: agents.name,
        printerId: printJobs.printerId,
        printerName: printers.name,
        status: printJobs.status,
        error: printJobs.error,
        requestedBy: printJobs.requestedBy,
        retries: printJobs.retries,
        deliveryAttempts: printJobs.deliveryAttempts,
        claimedAt: printJobs.claimedAt,
        deliveredAt: printJobs.deliveredAt,
        ackedAt: printJobs.ackedAt,
        expiresAt: printJobs.expiresAt,
        createdAt: printJobs.createdAt,
        updatedAt: printJobs.updatedAt,
      })
      .from(printJobs)
      .leftJoin(agents, and(eq(agents.id, printJobs.agentId), eq(agents.tenantId, tenantId)))
      .leftJoin(printers, and(eq(printers.id, printJobs.printerId), eq(printers.tenantId, tenantId)))
      .where(eq(printJobs.tenantId, tenantId))
      .orderBy(desc(printJobs.createdAt))
      .limit(50),
    db
      .select({
        total: count(),
        online: sql<number>`COUNT(*) FILTER (WHERE ${agents.lifecycle} = 'active' AND ${agents.status} = 'online' AND ${agents.lastSeenAt} IS NOT NULL AND ${agents.lastSeenAt} >= ${new Date(now.getTime() - staleThresholdSeconds * 1000)} AND ${agents.lastSeenAt} <= ${now})`,
      })
      .from(agents)
      .where(eq(agents.tenantId, tenantId)),
    db
      .select({
        total: sql<number>`COUNT(*) FILTER (WHERE ${printers.lifecycle} = 'active' AND ${printers.inventoryPresent} = true)`,
        saved: sql<number>`COUNT(*) FILTER (WHERE ${printers.lifecycle} <> 'active' OR ${printers.inventoryPresent} = false)`,
        online: sql<number>`COUNT(*) FILTER (WHERE ${printers.lifecycle} = 'active' AND ${printers.inventoryPresent} = true AND ${printers.status} IN ('online', 'busy') AND ${printers.lastSeenAt} >= ${new Date(now.getTime() - printerStaleThresholdSeconds() * 1000)} AND ${printers.lastSeenAt} <= ${now} AND ${agents.lifecycle} = 'active' AND ${agents.status} = 'online' AND ${agents.lastSeenAt} >= ${new Date(now.getTime() - staleThresholdSeconds * 1000)} AND ${agents.lastSeenAt} <= ${now})`,
      })
      .from(printers)
      .leftJoin(agents, and(eq(agents.id, printers.agentId), eq(agents.tenantId, tenantId)))
      .where(and(eq(printers.tenantId, tenantId), eq(printers.sharedWithGateway, true), nonVirtualPrinterPredicate())),
  ]);

  const agentHasMore = agentRows.length > DASHBOARD_FLEET_PAGE_SIZE;
  const printerHasMore = printerRows.length > DASHBOARD_FLEET_PAGE_SIZE;
  const visibleAgents = agentRows.slice(0, DASHBOARD_FLEET_PAGE_SIZE).map((agent) => ({
    ...agent,
    currentPrinterCount: Number(agent.currentPrinterCount ?? 0),
    reportedStatus: agent.status,
    status: getEffectiveAgentStatus(agent, now),
    staleThresholdSeconds,
  }));
  const visiblePrinters = printerRows.slice(0, DASHBOARD_FLEET_PAGE_SIZE).map((printer) => ({
    ...printer,
    agentStaleThresholdSeconds: staleThresholdSeconds,
  }));
  const agentSummary = agentSummaryRows[0] ?? { total: 0, online: 0 };
  const printerSummary = printerSummaryRows[0] ?? { total: 0, online: 0, saved: 0 };

  return {
    agents: visibleAgents,
    printers: visiblePrinters,
    jobs: allJobs,
    fleet: {
      pageSize: DASHBOARD_FLEET_PAGE_SIZE,
      agentOffset,
      agentHasMore,
      printerOffset,
      printerHasMore,
      totalAgents: Number(agentSummary.total ?? 0),
      onlineAgents: Number(agentSummary.online ?? 0),
      totalPrinters: Number(printerSummary.total ?? 0),
      onlinePrinters: Number(printerSummary.online ?? 0),
      savedPrinters: Number(printerSummary.saved ?? 0),
    },
  };
}
