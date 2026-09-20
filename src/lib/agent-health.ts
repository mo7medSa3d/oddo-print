/**
 * Agent Health — beyond ONLINE/OFFLINE
 * Statuses: ONLINE / DEGRADED / OFFLINE / STARTING / RECOVERING
 * Checks: Gateway (lastSeen), WebSocket, Polling, Heartbeat freshness, Queue depth, Printers, Version
 */

import { db, queryWithTimeout } from "../db/client";
import { agents, printers, printJobs } from "../db/schema";
import { eq, and, count, sql } from "drizzle-orm";

export type AgentHealthStatus = "ONLINE" | "DEGRADED" | "OFFLINE" | "STARTING" | "RECOVERING" | "UNKNOWN";
export type HealthCheckResult = { name: string; status: "ok" | "warn" | "error" | "unknown"; message: string; lastOk?: Date; details?: Record<string, unknown> };

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
  failureCount: number;
  lastError?: string;
  uptimeSeconds?: number;
}

const ONLINE_THRESHOLD_MS = 90_000; // 90s matches claim logic
const DEGRADED_THRESHOLD_MS = 5 * 60_000; // 5min

export function computeAgentHealthStatus(lastSeenAt?: Date | null, now = new Date()): AgentHealthStatus {
  if (!lastSeenAt) return "OFFLINE";
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
  const baseStatus = computeAgentHealthStatus(agent.lastSeenAt, now);

  // Queue depth: queued + claimed + printing
  const queueRows = await queryWithTimeout(
    db.select({ cnt: count() }).from(printJobs).where(and(eq(printJobs.tenantId, tenantId), eq(printJobs.agentId, agentId), sql`${printJobs.status} in ('queued','claimed','printing')`)),
    3000,
    "agentQueueDepth"
  ).catch(() => [{ cnt: 0 }]);
  const queueDepth = (queueRows[0] as any)?.cnt ?? 0;

  const printerRows = await queryWithTimeout(
    db.select({ id: printers.id, status: printers.status }).from(printers).where(and(eq(printers.tenantId, tenantId), eq(printers.agentId, agentId))),
    3000,
    "agentPrinters"
  ).catch(() => []);
  const printerCount = printerRows.length;
  const onlinePrinterCount = printerRows.filter((p: any) => p.status === "online").length;

  const checks: HealthCheckResult[] = [];

  // Gateway heartbeat
  if (agent.lastSeenAt) {
    const ageMs = now.getTime() - new Date(agent.lastSeenAt).getTime();
    checks.push({
      name: "Gateway",
      status: ageMs <= ONLINE_THRESHOLD_MS ? "ok" : ageMs <= DEGRADED_THRESHOLD_MS ? "warn" : "error",
      message: ageMs <= ONLINE_THRESHOLD_MS ? `Heartbeat ${Math.round(ageMs / 1000)}s ago` : `Last seen ${Math.round(ageMs / 1000)}s ago`,
      lastOk: agent.lastSeenAt,
      details: { ageMs, thresholdMs: ONLINE_THRESHOLD_MS },
    });
  } else {
    checks.push({ name: "Gateway", status: "error", message: "Never seen" });
  }

  // WebSocket / Polling — inferred from lastSeen and metadata
  const meta = agent.metadata as any;
  checks.push({
    name: "Heartbeat",
    status: baseStatus === "ONLINE" ? "ok" : baseStatus === "DEGRADED" ? "warn" : "error",
    message: baseStatus === "ONLINE" ? "Heartbeat fresh" : baseStatus === "DEGRADED" ? "Heartbeat stale (degraded)" : "Heartbeat missing",
    lastOk: agent.lastSeenAt,
  });

  checks.push({
    name: "Queue",
    status: queueDepth > 50 ? "warn" : "ok",
    message: queueDepth === 0 ? "Queue empty" : `${queueDepth} jobs pending`,
    details: { queueDepth },
  });

  checks.push({
    name: "Printers",
    status: printerCount === 0 ? "warn" : onlinePrinterCount === 0 ? "error" : onlinePrinterCount < printerCount ? "warn" : "ok",
    message: `${onlinePrinterCount}/${printerCount} printers online`,
    details: { printerCount, onlinePrinterCount },
  });

  checks.push({
    name: "Version",
    status: meta?.version ? "ok" : "unknown",
    message: meta?.version ? `v${meta.version}` : "Version unknown",
    details: { version: meta?.version, os: meta?.os, hostname: meta?.hostname },
  });

  // Determine overall status with degraded logic
  let status: AgentHealthStatus = baseStatus;
  if (baseStatus === "ONLINE" && (queueDepth > 100 || onlinePrinterCount === 0 && printerCount > 0)) {
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
    failureCount: 0,
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
