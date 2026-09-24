/**
 * Agent Health — beyond ONLINE/OFFLINE
 * Statuses: ONLINE / DEGRADED / OFFLINE / STARTING / UNKNOWN
 * Checks: Gateway (observed), Queue (observed), Printers (observed), Version (observed)
 * Inferred checks are explicitly labeled as INFERRED and not claimed as direct transport checks.
 *
 * STARTING: createdAt <5min AND never seen (observed from DB)
 * RECOVERING: NOT IMPLEMENTED — requires history, marked as NOT SUPPORTED in this runtime
 * failureCount: NOT MEASURED — returns null with explanation, not 0
 */

import { db, queryWithTimeout } from "../db/client";
import { agents, printers, printJobs } from "../db/schema";
import { eq, and, count, sql } from "drizzle-orm";
import { logWarn } from "./log";

export type AgentHealthStatus = "ONLINE" | "DEGRADED" | "OFFLINE" | "STARTING" | "UNKNOWN";
export type HealthCheckResult = {
  name: string;
  status: "ok" | "warn" | "error" | "unknown";
  message: string;
  observed: boolean;
  lastOk?: Date;
  details?: Record<string, unknown>;
};

export interface AgentHealth {
  agentId: string;
  tenantId: string;
  name: string;
  status: AgentHealthStatus;
  lastSeenAt?: Date;
  version?: string;
  checks: HealthCheckResult[];
  queueDepth: number;
  printerCount: number;
  onlinePrinterCount: number;
  failureCount: number | null;
  failureCountNote: string;
  lastError?: string;
  uptimeSeconds?: number;
}

const ONLINE_THRESHOLD_MS = 90_000; // 90s matches claim logic
const DEGRADED_THRESHOLD_MS = 5 * 60_000; // 5min
const STARTING_THRESHOLD_MS = 5 * 60_000;

export function computeAgentHealthStatus(lastSeenAt?: Date | null, createdAt?: Date | null, now = new Date()): AgentHealthStatus {
  if (!lastSeenAt) {
    if (createdAt) {
      const ageCreated = now.getTime() - new Date(createdAt).getTime();
      if (ageCreated <= STARTING_THRESHOLD_MS) return "STARTING";
    }
    return "OFFLINE";
  }
  const age = now.getTime() - new Date(lastSeenAt).getTime();
  if (age <= ONLINE_THRESHOLD_MS) return "ONLINE";
  if (age <= DEGRADED_THRESHOLD_MS) return "DEGRADED";
  return "OFFLINE";
}

export async function getAgentHealth(tenantId: string, agentId: string): Promise<AgentHealth | null> {
  const agentRows = await queryWithTimeout(
    db.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.id, agentId))).limit(1),
    3000,
    "getAgentHealth"
  );
  if (agentRows.length === 0) return null;
  const agent = agentRows[0] as any;

  const now = new Date();
  const baseStatus = computeAgentHealthStatus(agent.lastSeenAt, agent.createdAt, now);

  let queueRows: Array<{ cnt: number }> = [];
  let queueDataAvailable = true;
  try {
    queueRows = await queryWithTimeout(
      db.select({ cnt: count() }).from(printJobs).where(and(eq(printJobs.tenantId, tenantId), eq(printJobs.agentId, agentId), sql`${printJobs.status} in ('queued','claimed','printing')`)),
      3000,
      "agentQueueDepth"
    );
  } catch (error) {
    queueDataAvailable = false;
    logWarn("agent.health.queue_lookup_failed", { tenantId, agentId, error: error instanceof Error ? error.message : "unknown" });
  }
  const queueDepth = queueRows[0]?.cnt ?? 0;

  let printerRows: Array<{ id: string; status: string }> = [];
  let printerDataAvailable = true;
  try {
    printerRows = await queryWithTimeout(
      db.select({ id: printers.id, status: printers.status }).from(printers).where(and(eq(printers.tenantId, tenantId), eq(printers.agentId, agentId))),
      3000,
      "agentPrinters"
    );
  } catch (error) {
    printerDataAvailable = false;
    logWarn("agent.health.printer_lookup_failed", { tenantId, agentId, error: error instanceof Error ? error.message : "unknown" });
  }
  const printerCount = printerRows.length;
  const onlinePrinterCount = printerRows.filter((p) => p.status === "online").length;

  const checks: HealthCheckResult[] = [];

  // Observed: Gateway heartbeat (direct from DB lastSeenAt)
  if (agent.lastSeenAt) {
    const ageMs = now.getTime() - new Date(agent.lastSeenAt).getTime();
    checks.push({
      name: "Gateway",
      status: ageMs <= ONLINE_THRESHOLD_MS ? "ok" : ageMs <= DEGRADED_THRESHOLD_MS ? "warn" : "error",
      message: ageMs <= ONLINE_THRESHOLD_MS ? `Heartbeat ${Math.round(ageMs / 1000)}s ago (observed)` : `Last seen ${Math.round(ageMs / 1000)}s ago (observed)`,
      observed: true,
      lastOk: agent.lastSeenAt,
      details: { ageMs, thresholdMs: ONLINE_THRESHOLD_MS, source: "agents.last_seen_at" },
    });
  } else {
    checks.push({ name: "Gateway", status: "error", message: "Never seen (observed from DB)", observed: true });
  }

  // Inferred: Heartbeat freshness derived from Gateway, not separate transport
  checks.push({
    name: "Heartbeat (inferred from Gateway)",
    status: baseStatus === "ONLINE" ? "ok" : baseStatus === "DEGRADED" ? "warn" : baseStatus === "STARTING" ? "unknown" : "error",
    message: baseStatus === "ONLINE" ? "Heartbeat fresh (inferred from Gateway lastSeen)" : baseStatus === "DEGRADED" ? "Heartbeat stale (inferred)" : baseStatus === "STARTING" ? "Agent starting, no heartbeat yet (observed createdAt)" : "Heartbeat missing (observed)",
    observed: false,
    lastOk: agent.lastSeenAt,
    details: { inferredFrom: "Gateway", note: "WebSocket/Polling transport not directly observed, only inferred from heartbeat" },
  });

  // Observed: Queue depth from DB
  checks.push(queueDataAvailable ? {
    name: "Queue",
    status: queueDepth > 50 ? "warn" : "ok",
    message: queueDepth === 0 ? "Queue empty (observed from print_jobs)" : `${queueDepth} jobs pending (observed)`,
    observed: true,
    details: { queueDepth, source: "print_jobs count where status in queued,claimed,printing" },
  } : {
    name: "Queue",
    status: "unknown",
    message: "Queue data unavailable (database lookup failed)",
    observed: false,
    details: { source: "print_jobs", unavailable: true },
  });

  // Observed: Printers from DB
  checks.push(printerDataAvailable ? {
    name: "Printers",
    status: printerCount === 0 ? "warn" : onlinePrinterCount === 0 ? "error" : onlinePrinterCount < printerCount ? "warn" : "ok",
    message: `${onlinePrinterCount}/${printerCount} printers online (observed from printers table)`,
    observed: true,
    details: { printerCount, onlinePrinterCount, source: "printers table" },
  } : {
    name: "Printers",
    status: "unknown",
    message: "Printer data unavailable (database lookup failed)",
    observed: false,
    details: { source: "printers", unavailable: true },
  });

  // Observed: Version from metadata
  const meta = agent.metadata as any;
  checks.push({
    name: "Version",
    status: meta?.version ? "ok" : "unknown",
    message: meta?.version ? `v${meta.version} (observed from metadata)` : "Version unknown (no metadata.version)",
    observed: true,
    details: { version: meta?.version, os: meta?.os, hostname: meta?.hostname, source: "agents.metadata" },
  });

  // Determine overall status with degraded logic — only using observed data
  let status: AgentHealthStatus = baseStatus;
  if (baseStatus === "ONLINE" && (!queueDataAvailable || !printerDataAvailable || queueDepth > 100 || (onlinePrinterCount === 0 && printerCount > 0))) {
    status = "DEGRADED";
  }

  return {
    agentId: agent.id,
    tenantId: agent.tenantId,
    name: agent.name,
    status,
    lastSeenAt: agent.lastSeenAt ?? undefined,
    version: meta?.version,
    checks,
    queueDepth,
    printerCount,
    onlinePrinterCount,
    failureCount: null,
    failureCountNote: "NOT MEASURED — failure count requires persistent failure tracking, not implemented in this runtime; returning null to avoid false 0",
    lastError: undefined,
  };
}

export async function getAllAgentsHealth(tenantId: string): Promise<AgentHealth[]> {
  const allAgents = await queryWithTimeout(
    db.select().from(agents).where(eq(agents.tenantId, tenantId)),
    3000,
    "getAllAgentsHealth"
  );
  const results: AgentHealth[] = [];
  for (const a of allAgents as any[]) {
    const h = await getAgentHealth(tenantId, a.id);
    if (h) results.push(h);
  }
  return results;
}
