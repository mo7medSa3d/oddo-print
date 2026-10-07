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
import { eq, and, count, sql, asc } from "drizzle-orm";
import { logWarn } from "./log";
import { gatewayNow, parseDbTimeMs } from "./database-clock";
import { agentStaleThresholdSeconds, printerStaleThresholdSeconds } from "./stale-threshold";

export type AgentHealthStatus = "ONLINE" | "DEGRADED" | "OFFLINE" | "STARTING" | "UNKNOWN";
export type HealthCheckResult = {
  name: string;
  status: "ok" | "warn" | "error" | "unknown";
  message: string;
  observed: boolean;
  // `null` is a real runtime value here: an agent that has never been seen has
  // agents.last_seen_at IS NULL, and that null is passed through to lastOk and
  // serialized in the API response. The previous `as any` hid this mismatch;
  // widening the declaration keeps the emitted JSON byte-identical.
  lastOk?: Date | null;
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

// Read the threshold fresh per evaluation (not snapshotted at module load):
// enforcement (agent-availability.ts) and display must share one value even
// across tests or a future reloadable config. The snapshot cost is one
// clamped Number() parse.
function onlineThresholdMs(): number {
  return agentStaleThresholdSeconds() * 1000;
}
const DEGRADED_THRESHOLD_MS = 5 * 60_000; // 5min
const STARTING_THRESHOLD_MS = 5 * 60_000;

export function computeAgentHealthStatus(lastSeenAt?: Date | null, createdAt?: Date | null, now = gatewayNow(), status = "online"): AgentHealthStatus {
  if (status === "offline" && lastSeenAt) return "OFFLINE";
  if (!lastSeenAt) {
    if (createdAt) {
      const createdMs = parseDbTimeMs(createdAt);
      const ageCreated = createdMs === null ? Number.POSITIVE_INFINITY : now.getTime() - createdMs;
      if (ageCreated <= STARTING_THRESHOLD_MS) return "STARTING";
    }
    return "OFFLINE";
  }
  const seenMs = parseDbTimeMs(lastSeenAt);
  const age = seenMs === null ? Number.POSITIVE_INFINITY : now.getTime() - seenMs;
  // A future lastSeenAt (clock skew or bad write) must never read as
  // ONLINE: the agent is not provably alive. Mirror the availability gate
  // (agent-availability.ts) and printer health, which both reject age < 0.
  if (age < 0) return "OFFLINE";
  if (age <= onlineThresholdMs()) return "ONLINE";
  if (age <= DEGRADED_THRESHOLD_MS) return "DEGRADED";
  return "OFFLINE";
}

export async function getAgentHealth(tenantId: string, agentId: string): Promise<AgentHealth | null> {
  const agentRows = await queryWithTimeout(
    () => db.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.id, agentId))).limit(1),
    3000,
    "getAgentHealth"
  );
  if (agentRows.length === 0) return null;
  // Typed row from the Drizzle select above. The previous `as any` erased the
  // row type on the health-classification decision below, so a renamed/absent
  // column would have silently degraded to STATUS "OFFLINE" instead of failing
  // to compile.
  const agent = agentRows[0];

  const now = gatewayNow();
  const baseStatus = agent.lifecycle !== "active"
    ? "OFFLINE"
    : agent.status === "offline"
      ? "OFFLINE"
      : computeAgentHealthStatus(agent.lastSeenAt, agent.createdAt, now, agent.status);

  let queueRows: Array<{ cnt: number }> = [];
  let queueDataAvailable = true;
  try {
    queueRows = await queryWithTimeout(
      () => db.select({ cnt: count() }).from(printJobs).where(and(eq(printJobs.tenantId, tenantId), eq(printJobs.agentId, agentId), sql`${printJobs.status} in ('queued','claimed','printing')`)),
      3000,
      "agentQueueDepth"
    );
  } catch (error) {
    queueDataAvailable = false;
    logWarn("agent.health.queue_lookup_failed", { tenantId, agentId, error: error instanceof Error ? error.message : "unknown" });
  }
  const queueDepth = queueRows[0]?.cnt ?? 0;

  let printerRows: Array<{ id: string; status: string; lifecycle: string; lastSeenAt: Date | string | null }> = [];
  let printerDataAvailable = true;
  try {
    printerRows = await queryWithTimeout(
      () => db.select({ id: printers.id, status: printers.status, lifecycle: printers.lifecycle, lastSeenAt: printers.lastSeenAt }).from(printers).where(and(eq(printers.tenantId, tenantId), eq(printers.agentId, agentId))),
      3000,
      "agentPrinters"
    );
  } catch (error) {
    printerDataAvailable = false;
    logWarn("agent.health.printer_lookup_failed", { tenantId, agentId, error: error instanceof Error ? error.message : "unknown" });
  }
  const printerCount = printerRows.length;
  // "busy" is an executable state (queue accepted work, still claimable — see
  // isPrinterStatusExecutable). Counting only "online" reports error for an
  // all-busy (actively processing) fleet.
  // Health counts are observation evidence, not raw DB status: retired or
  // disabled printers and stale observations must not read as available
  // capacity, or fleet counts advertise healthy evidence execution gates
  // would reject.
  const printerFreshnessMs = printerStaleThresholdSeconds() * 1000;
  const onlinePrinterCount = printerRows.filter((p) => {
    if (p.lifecycle !== "active") return false;
    if (p.status !== "online" && p.status !== "busy") return false;
    const seenMs = parseDbTimeMs(p.lastSeenAt);
    if (seenMs === null) return false;
    const ageMs = now.getTime() - seenMs;
    return ageMs >= 0 && ageMs <= printerFreshnessMs;
  }).length;

  const checks: HealthCheckResult[] = [];

  // Observed: Gateway heartbeat (direct from DB lastSeenAt)
  if (agent.lastSeenAt) {
    const seenMs = parseDbTimeMs(agent.lastSeenAt);
    const ageMs = seenMs === null ? Number.POSITIVE_INFINITY : now.getTime() - seenMs;
    // A future lastSeenAt (clock skew or bad write) is an untrustworthy
    // observation: never "ok", and worse than merely stale.
    const onlineMs = onlineThresholdMs();
    const gatewayStatus = agent.lifecycle !== "active" || agent.status !== "online"
      ? "error"
      : ageMs < 0 || ageMs > DEGRADED_THRESHOLD_MS ? "error" : ageMs > onlineMs ? "warn" : "ok";
    checks.push({
      name: "Gateway",
      status: gatewayStatus,
      message: ageMs >= 0 && ageMs <= onlineMs ? `Heartbeat ${Math.round(ageMs / 1000)}s ago (observed)` : `Last seen ${Math.round(ageMs / 1000)}s ago (observed)`,
      observed: true,
      lastOk: agent.lastSeenAt,
      details: { ageMs, thresholdMs: onlineMs, source: "agents.last_seen_at" },
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

  // Observed: Version from metadata. `agents.metadata` is declared as
  // jsonb().$type<{ hostname?, os?, osVersion?, version? }>() in src/db/schema.ts,
  // so the cast to `any` was discarding a precise type that already existed.
  const meta = agent.metadata;
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

export async function getAllAgentsHealth(tenantId: string, limit = 100, offset = 0): Promise<AgentHealth[]> {
  const boundedLimit = Math.max(1, Math.min(201, Math.trunc(limit)));
  const boundedOffset = Math.max(0, Math.min(100_000, Math.trunc(offset)));
  // Bound tenant cardinality before the per-Agent fan-out. Stable ID ordering
  // keeps offset pagination deterministic for this diagnostic endpoint while
  // preserving the historical array response contract at the route boundary.
  const allAgents = await queryWithTimeout(
    () => db.select().from(agents)
      .where(eq(agents.tenantId, tenantId))
      .orderBy(asc(agents.id))
      .limit(boundedLimit)
      .offset(boundedOffset),
    3000,
    "getAllAgentsHealth"
  );
  // Bounded fan-out (5): the old sequential loop degraded linearly on large
  // fleets, while an unbounded Promise.all over N agents × 3 queries each
  // would exhaust the 20-connection pool. Chunks keep latency flat without
  // stampeding the database.
  const results: AgentHealth[] = [];
  for (let i = 0; i < allAgents.length; i += 5) {
    const chunk = await Promise.all(
      allAgents.slice(i, i + 5).map((a) => getAgentHealth(tenantId, a.id)),
    );
    for (const h of chunk) if (h) results.push(h);
  }
  return results;
}
