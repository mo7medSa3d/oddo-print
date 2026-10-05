import { gatewayNow, parseDbTimeMs } from "./database-clock";

// Canonical threshold API lives in the dependency-free stale-threshold
// module (safe for client bundles); re-exported here so every existing
// server-side importer keeps working unchanged.
import {
  DEFAULT_AGENT_STALE_THRESHOLD_SECONDS,
  DEFAULT_PRINTER_STALE_THRESHOLD_SECONDS,
  agentStaleThresholdSeconds,
  printerStaleThresholdSeconds,
} from "./stale-threshold";

export {
  DEFAULT_AGENT_STALE_THRESHOLD_SECONDS,
  DEFAULT_PRINTER_STALE_THRESHOLD_SECONDS,
  agentStaleThresholdSeconds,
  printerStaleThresholdSeconds,
};


export type ObservationFreshness = "fresh" | "stale" | "missing";

function observationFreshness(
  lastSeenAt: Date | string | null | undefined,
  thresholdSeconds: number,
  now = gatewayNow(),
): ObservationFreshness {
  if (!lastSeenAt) return "missing";
  const lastSeen = parseDbTimeMs(lastSeenAt);
  if (lastSeen === null) return "missing";
  const ageSeconds = (now.getTime() - lastSeen) / 1000;
  return ageSeconds >= 0 && ageSeconds <= thresholdSeconds ? "fresh" : "stale";
}

export function getPrinterObservationFreshness(
  lastSeenAt: Date | string | null | undefined,
  now = gatewayNow(),
): ObservationFreshness {
  return observationFreshness(lastSeenAt, printerStaleThresholdSeconds(), now);
}

export function getAgentHeartbeatFreshness(
  lastSeenAt: Date | string | null | undefined,
  now = gatewayNow(),
): ObservationFreshness {
  return observationFreshness(lastSeenAt, agentStaleThresholdSeconds(), now);
}

export function isPrinterObservationFresh(
  lastSeenAt: Date | string | null | undefined,
  now = gatewayNow(),
): boolean {
  if (!lastSeenAt) return false;
  // parseDbTimeMs: node-postgres naive "YYYY-MM-DD HH:MM:SS" strings are UTC;
  // new Date(str) would parse them as host-local time (TZ-dependent freshness).
  const lastSeen = parseDbTimeMs(lastSeenAt);
  if (lastSeen === null) return false;
  const ageSeconds = (now.getTime() - lastSeen) / 1000;
  return ageSeconds >= 0 && ageSeconds <= printerStaleThresholdSeconds();
}

export type AgentAvailability = {
  available: boolean;
  reason: "active-online-fresh" | "inactive-lifecycle" | "offline" | "stale" | "missing-heartbeat";
};

export function getAgentAvailability(
  agent: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null },
  // Presence timestamps are written with PostgreSQL now(); the comparison must
  // use the same clock, not the Node host clock (see database-clock.ts).
  now = gatewayNow(),
): AgentAvailability {
  if (agent.lifecycle !== "active") return { available: false, reason: "inactive-lifecycle" };
  if (agent.status !== "online") return { available: false, reason: "offline" };
  if (!agent.lastSeenAt) return { available: false, reason: "missing-heartbeat" };
  const lastSeen = parseDbTimeMs(agent.lastSeenAt);
  if (lastSeen === null) return { available: false, reason: "missing-heartbeat" };
  const ageSeconds = (now.getTime() - lastSeen) / 1000;
  if (ageSeconds < 0 || ageSeconds > agentStaleThresholdSeconds()) {
    return { available: false, reason: "stale" };
  }
  return { available: true, reason: "active-online-fresh" };
}

export function isAgentAvailableForJob(
  agent: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null },
  now = gatewayNow(),
): boolean {
  return getAgentAvailability(agent, now).available;
}

export function getEffectivePrinterStatus(
  printer: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null },
  _agent?: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null } | null,
  now = gatewayNow(),
): "online" | "offline" | "busy" | "error" | "disabled" | "retired" | "unknown" {
  if (printer.lifecycle === "disabled") return "disabled";
  if (printer.lifecycle === "retired") return "retired";
  if (printer.lifecycle !== "active") return "unknown";

  // Printer evidence and Agent/cloud reachability are different facts. The
  // APIs expose Agent presence separately and routing has its own Agent gate;
  // never manufacture a physical-printer offline state because the Agent is
  // stale or disconnected. A stale printer observation becomes unknown.
  if (!isPrinterObservationFresh(printer.lastSeenAt, now)) return "unknown";

  const rawStatus = (printer.status ?? "").toLowerCase().trim();
  if (["online", "offline", "busy", "error", "unknown"].includes(rawStatus)) {
    return rawStatus as "online" | "offline" | "busy" | "error" | "unknown";
  }
  return "unknown";
}
