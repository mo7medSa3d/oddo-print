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
  agent?: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null } | null,
  now = gatewayNow(),
): "online" | "offline" | "disabled" | "retired" | "unknown" {
  if (printer.lifecycle === "disabled") return "disabled";
  if (printer.lifecycle === "retired") return "retired";
  if (printer.lifecycle !== "active") return "offline";

  // If the parent agent is missing or unavailable (stale heartbeat, offline, disabled),
  // the printer cannot be reached physically. It is effectively offline.
  if (!agent || !isAgentAvailableForJob(agent, now)) {
    return "offline";
  }
  if (!isPrinterObservationFresh(printer.lastSeenAt, now)) {
    return "offline";
  }

  const rawStatus = (printer.status ?? "").toLowerCase().trim();
  if (rawStatus === "online") return "online";
  if (rawStatus === "offline") return "offline";
  return rawStatus ? (rawStatus as "unknown") : "unknown";
}
