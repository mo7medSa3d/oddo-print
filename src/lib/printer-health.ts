/**
 * Printer Health + Capability Matrix — EVIDENCE-BASED
 * Statuses: ONLINE / IDLE / PRINTING / PAPER_OUT / OFFLINE / ERROR / DRIVER_ERROR / SPOOLER_ERROR / UNREACHABLE / UNKNOWN
 * Only with evidence — status must come from agent heartbeat or explicit error, not assumed.
 *
 * Evidence separation:
 * - DATABASE STATUS: printers.status column (may be stale)
 * - OBSERVED AGENT STATUS: lastSeenAt freshness, agent reports
 * - ACTUAL SPOOLER STATUS: requires spooler_name + spooler-specific health from capabilities/config, not just DB status
 * - ACTUAL NETWORK REACHABILITY: requires agent probe evidence, not just DB
 *
 * If current evidence unavailable: UNKNOWN
 * Do NOT report SPOOLER OK from only DB printer state.
 * Do NOT report ONLINE from stale data.
 */

import { db, queryWithTimeout } from "../db/client";
import { printers } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { gatewayNow } from "./database-clock";
import { getSupportedDocumentTypes, type ProtocolType, type TransportType } from "./printer-capability";

export type PrinterHealthStatus =
  | "ONLINE"
  | "IDLE"
  | "PRINTING"
  | "PAPER_OUT"
  | "OFFLINE"
  | "ERROR"
  | "DRIVER_ERROR"
  | "SPOOLER_ERROR"
  | "UNREACHABLE"
  | "UNKNOWN";

export interface PrinterCapabilityMatrix {
  printerId: string;
  tenantId: string;
  name: string;
  transport: "network" | "usb" | "spooler" | "ipp" | "ipps" | "unknown";
  protocol: "raw" | "escpos" | "zpl" | "tspl" | "ipp" | "ipps" | "spooler" | "windows_spooler" | "unknown";
  deviceClass: "thermal" | "laser" | "inkjet" | "label" | "other" | "unknown";
  documentTypes: string[];
  duplexCapable: boolean | null;
  colorCapable: boolean | null;
  paperWidths: number[] | null;
  driver: { name?: string; version?: string; health: "ok" | "warn" | "error" | "unknown"; message: string; evidence: string };
  spooler: { name?: string; status: "ok" | "error" | "unknown"; message: string; evidence: string };
  status: PrinterHealthStatus;
  statusEvidence: string;
  statusFreshness: { lastSeenAt?: Date; ageMs?: number; fresh: boolean; source: string };
  lastSeenAt?: Date;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
}

const FRESHNESS_THRESHOLD_MS = 90_000;

function isFresh(lastSeenAt?: Date | null, now = gatewayNow()): { fresh: boolean; ageMs?: number } {
  if (!lastSeenAt) return { fresh: false };
  const ageMs = now.getTime() - new Date(lastSeenAt).getTime();
  // Future-dated observations are clock-invalid and must never be treated as
  // fresh. Execution gates use the same rule, so health and delivery converge.
  return { fresh: ageMs >= 0 && ageMs <= FRESHNESS_THRESHOLD_MS, ageMs };
}

/**
 * Evidence-based status normalization.
 * - Does NOT map online->IDLE unless explicitly defined by agent contract (online means DB says online, but IDLE requires explicit idle evidence)
 * - Verifies freshness: if lastSeenAt stale, returns UNKNOWN or OFFLINE with evidence
 */
export function normalizePrinterStatus(
  rawStatus?: string | null,
  evidence?: { lastSeenAt?: Date | null; config?: any; capabilities?: any; error?: string; now?: Date }
): { status: PrinterHealthStatus; evidence: string; freshness: { lastSeenAt?: Date; ageMs?: number; fresh: boolean; source: string } } {
  const now = evidence?.now ?? gatewayNow();
  const freshnessCheck = isFresh(evidence?.lastSeenAt ?? null, now);
  const freshness = {
    lastSeenAt: evidence?.lastSeenAt ?? undefined,
    ageMs: freshnessCheck.ageMs,
    fresh: freshnessCheck.fresh,
    source: "printers.last_seen_at + agents.last_seen_at (observed)",
  };

  // If no status at all
  if (!rawStatus) {
    return { status: "UNKNOWN", evidence: "No status reported by agent (DATABASE STATUS missing)", freshness };
  }

  // If stale evidence, do NOT report ONLINE/IDLE as current
  if (!freshness.fresh) {
    if (evidence?.lastSeenAt) {
      return {
        status: "UNKNOWN",
        evidence: `Stale evidence: lastSeen ${Math.round((freshness.ageMs ?? 0) / 1000)}s ago > ${FRESHNESS_THRESHOLD_MS / 1000}s threshold, cannot report ONLINE from stale data (OBSERVED AGENT STATUS stale)`,
        freshness,
      };
    }
    return { status: "UNKNOWN", evidence: "No freshness evidence (lastSeenAt missing), cannot determine current status", freshness };
  }

  const s = rawStatus.toLowerCase();

  // Explicit mappings only when defined by agent contract
  // Agent contract: online = reachable, idle = explicitly idle, printing/busy = printing
  // We should NOT map online->IDLE unless agent explicitly reports idle
  if (s === "idle") return { status: "IDLE", evidence: `Agent explicitly reports IDLE (OBSERVED AGENT STATUS, fresh ${Math.round((freshness.ageMs ?? 0) / 1000)}s ago)`, freshness };
  if (s === "online") return { status: "ONLINE", evidence: `Agent reports ONLINE (DATABASE STATUS + OBSERVED fresh heartbeat ${Math.round((freshness.ageMs ?? 0) / 1000)}s ago)`, freshness };
  if (s === "busy" || s === "printing") return { status: "PRINTING", evidence: `Agent reports ${rawStatus} (OBSERVED AGENT STATUS)`, freshness };
  if (s === "offline") return { status: "OFFLINE", evidence: `Agent reports OFFLINE (OBSERVED AGENT STATUS, fresh)`, freshness };
  if (s === "error") {
    if (evidence?.error?.toLowerCase().includes("paper")) return { status: "PAPER_OUT", evidence: `Error contains paper out: ${evidence.error.slice(0, 100)} (OBSERVED error)`, freshness };
    if (evidence?.error?.toLowerCase().includes("driver")) return { status: "DRIVER_ERROR", evidence: `Error indicates driver: ${evidence.error.slice(0, 100)} (OBSERVED error)`, freshness };
    if (evidence?.error?.toLowerCase().includes("spooler")) return { status: "SPOOLER_ERROR", evidence: `Error indicates spooler: ${evidence.error.slice(0, 100)} (OBSERVED error)`, freshness };
    return { status: "ERROR", evidence: `Agent reports ERROR: ${evidence?.error?.slice(0, 100) ?? rawStatus} (OBSERVED)`, freshness };
  }
  if (s.includes("paper")) return { status: "PAPER_OUT", evidence: `Status indicates paper issue: ${rawStatus} (OBSERVED)`, freshness };
  if (s.includes("unreachable") || s.includes("timeout")) return { status: "UNREACHABLE", evidence: `Status indicates unreachable: ${rawStatus} (ACTUAL NETWORK REACHABILITY evidence)`, freshness };
  return { status: "UNKNOWN", evidence: `Unrecognized status ${rawStatus}, requires evidence (DATABASE STATUS=${rawStatus} but no matching contract)`, freshness };
}

export async function getPrinterCapabilityMatrix(tenantId: string, printerId: string): Promise<PrinterCapabilityMatrix | null> {
  const rows = await queryWithTimeout(
    db.select().from(printers).where(and(eq(printers.tenantId, tenantId), eq(printers.id, printerId))).limit(1),
    3000,
    "getPrinterCapability"
  );
  if (rows.length === 0) return null;
  const p = rows[0] as any;
  const config = (p.config ?? {}) as any;
  const caps = (p.capabilities ?? {}) as any;

  const documentTypes = getSupportedDocumentTypes(
    p.protocol as ProtocolType,
    p.connectionType as TransportType,
  );

  const statusInfo = normalizePrinterStatus(p.status, { lastSeenAt: p.lastSeenAt, config, capabilities: caps });

  // Driver health: evidence-based, not from DB status alone
  const driverName = caps.driver_name ?? config.driver_name;
  const driverVersion = caps.driver_version;
  const driverError = caps.driver_error;
  let driverHealth: "ok" | "warn" | "error" | "unknown" = "unknown";
  let driverMessage = "Driver info not reported (ACTUAL DRIVER STATUS unavailable)";
  let driverEvidence = "No driver evidence in capabilities/config (DATABASE STATUS only)";
  if (driverError) {
    driverHealth = "error";
    driverMessage = `Driver error: ${driverError} (OBSERVED from capabilities.driver_error)`;
    driverEvidence = `capabilities.driver_error present: ${driverError.slice(0, 100)}`;
  } else if (driverName) {
    // Only report OK if we have explicit driver name AND fresh evidence
    if (statusInfo.freshness.fresh) {
      driverHealth = "ok";
      driverMessage = `Driver ${driverName} reported (OBSERVED, fresh)`;
      driverEvidence = `capabilities.driver_name=${driverName} + fresh lastSeen`;
    } else {
      driverHealth = "unknown";
      driverMessage = `Driver ${driverName} reported but freshness stale (DATABASE STATUS only)`;
      driverEvidence = `driver_name present but lastSeen stale ${Math.round((statusInfo.freshness.ageMs ?? 0) / 1000)}s ago`;
    }
  }

  // Spooler health: evidence-based, NOT from DB printer state alone
  const spoolerName = config.spooler_name;
  let spoolerStatus: "ok" | "error" | "unknown" = "unknown";
  let spoolerMessage = "Not using spooler transport or no spooler evidence";
  let spoolerEvidence = "No spooler evidence (requires spooler_name + spooler health)";
  if (p.connectionType === "spooler" || p.protocol === "spooler" || p.protocol === "windows_spooler") {
    if (!spoolerName) {
      spoolerStatus = "unknown";
      spoolerMessage = "Spooler transport but spooler_name missing (DATABASE STATUS incomplete)";
      spoolerEvidence = "connectionType=spooler but config.spooler_name missing";
    } else if (caps.spooler_status) {
      // Actual spooler status from agent probe
      spoolerStatus = caps.spooler_status === "ok" ? "ok" : caps.spooler_status === "error" ? "error" : "unknown";
      spoolerMessage = `Spooler ${spoolerName} status ${caps.spooler_status} (ACTUAL SPOOLER STATUS from agent)`;
      spoolerEvidence = `capabilities.spooler_status=${caps.spooler_status} + spooler_name=${spoolerName}`;
    } else if (statusInfo.freshness.fresh && (p.status === "online" || p.status === "idle")) {
      // We have fresh heartbeat and DB says online, but no explicit spooler probe — report UNKNOWN, not OK
      spoolerStatus = "unknown";
      spoolerMessage = `Spooler ${spoolerName} — no explicit spooler health probe, only DB status (DATABASE STATUS only, not ACTUAL SPOOLER STATUS)`;
      spoolerEvidence = `spooler_name=${spoolerName} present but capabilities.spooler_status missing, only printers.status=${p.status} (stale risk)`;
    } else {
      spoolerStatus = "unknown";
      spoolerMessage = `Spooler ${spoolerName} — status unknown (no ACTUAL SPOOLER STATUS evidence)`;
      spoolerEvidence = `spooler_name=${spoolerName} but no spooler_status in capabilities`;
    }
  }

  return {
    printerId: p.id,
    tenantId: p.tenantId,
    name: p.name,
    transport: p.connectionType as any,
    protocol: p.protocol as any,
    deviceClass: p.deviceClass as any,
    documentTypes,
    duplexCapable: config.duplex_capable ?? caps.duplex_capable ?? null,
    colorCapable: config.color_capable ?? caps.color_capable ?? null,
    paperWidths: config.paper_widths ?? caps.paper_widths ?? null,
    driver: { name: driverName, version: driverVersion, health: driverHealth, message: driverMessage, evidence: driverEvidence },
    spooler: { name: spoolerName, status: spoolerStatus, message: spoolerMessage, evidence: spoolerEvidence },
    status: statusInfo.status,
    statusEvidence: statusInfo.evidence,
    statusFreshness: statusInfo.freshness,
    lastSeenAt: p.lastSeenAt ?? undefined,
    capabilities: caps,
    config,
  };
}

export async function getAllPrintersCapabilityMatrix(tenantId: string): Promise<PrinterCapabilityMatrix[]> {
  const all = await queryWithTimeout(
    db.select().from(printers).where(eq(printers.tenantId, tenantId)),
    3000,
    "getAllPrintersCapability"
  );
  const results: PrinterCapabilityMatrix[] = [];
  for (const p of all as any[]) {
    const m = await getPrinterCapabilityMatrix(tenantId, p.id);
    if (m) results.push(m);
  }
  return results;
}
