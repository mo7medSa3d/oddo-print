/**
 * Printer Health + Capability Matrix
 * Statuses: ONLINE / IDLE / PRINTING / PAPER_OUT / OFFLINE / ERROR / DRIVER_ERROR / SPOOLER_ERROR / UNREACHABLE / UNKNOWN
 * Only with evidence — status must come from agent heartbeat or explicit error, not assumed.
 */

import { db, queryWithTimeout } from "../db/client";
import { printers, printJobs, agents } from "../db/schema";
import { eq, and, count, sql, desc } from "drizzle-orm";

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
  driver: { name?: string; version?: string; health: "ok" | "warn" | "error" | "unknown"; message: string };
  spooler: { name?: string; status: "ok" | "error" | "unknown"; message: string };
  status: PrinterHealthStatus;
  statusEvidence: string;
  lastSeenAt?: Date;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
}

export function normalizePrinterStatus(rawStatus?: string | null, evidence?: { lastSeenAt?: Date; config?: any; capabilities?: any; error?: string }): { status: PrinterHealthStatus; evidence: string } {
  if (!rawStatus) return { status: "UNKNOWN", evidence: "No status reported by agent" };
  const s = rawStatus.toLowerCase();
  // Evidence-based mapping
  if (s === "online" || s === "idle") return { status: "IDLE", evidence: `Agent reports status=${rawStatus} with recent heartbeat` };
  if (s === "busy" || s === "printing") return { status: "PRINTING", evidence: `Agent reports status=${rawStatus}` };
  if (s === "offline") return { status: "OFFLINE", evidence: "Agent reports offline or heartbeat missed" };
  if (s === "error") {
    if (evidence?.error?.toLowerCase().includes("paper")) return { status: "PAPER_OUT", evidence: `Error contains paper out: ${evidence.error.slice(0, 100)}` };
    if (evidence?.error?.toLowerCase().includes("driver")) return { status: "DRIVER_ERROR", evidence: `Error indicates driver: ${evidence.error.slice(0, 100)}` };
    if (evidence?.error?.toLowerCase().includes("spooler")) return { status: "SPOOLER_ERROR", evidence: `Error indicates spooler: ${evidence.error.slice(0, 100)}` };
    return { status: "ERROR", evidence: `Agent reports error: ${evidence?.error?.slice(0, 100) ?? rawStatus}` };
  }
  if (s.includes("paper")) return { status: "PAPER_OUT", evidence: `Status indicates paper issue: ${rawStatus}` };
  if (s.includes("unreachable") || s.includes("timeout")) return { status: "UNREACHABLE", evidence: `Status indicates unreachable: ${rawStatus}` };
  return { status: "UNKNOWN", evidence: `Unrecognized status ${rawStatus}, requires evidence` };
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

  // Determine document types from protocol
  let documentTypes: string[] = [];
  switch (p.protocol) {
    case "escpos":
      documentTypes = ["escpos", "raw"];
      break;
    case "zpl":
      documentTypes = ["zpl", "raw"];
      break;
    case "tspl":
      documentTypes = ["tspl", "raw"];
      break;
    case "raw":
      documentTypes = ["raw", "escpos", "zpl", "tspl"];
      break;
    case "ipp":
    case "ipps":
      documentTypes = ["pdf", "image", "raw"];
      break;
    case "spooler":
    case "windows_spooler":
      documentTypes = ["pdf", "image", "raw", "escpos"];
      break;
    default:
      documentTypes = ["raw"];
  }

  const statusInfo = normalizePrinterStatus(p.status, { lastSeenAt: p.lastSeenAt, config, capabilities: caps });

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
    driver: {
      name: caps.driver_name ?? config.driver_name,
      version: caps.driver_version,
      health: caps.driver_error ? "error" : caps.driver_name ? "ok" : "unknown",
      message: caps.driver_error ? `Driver error: ${caps.driver_error}` : caps.driver_name ? `Driver ${caps.driver_name} OK` : "Driver info not reported",
    },
    spooler: {
      name: config.spooler_name,
      status: p.connectionType === "spooler" ? (p.status === "online" || p.status === "idle" ? "ok" : "error") : "unknown",
      message: config.spooler_name ? `Spooler ${config.spooler_name}` : "Not using spooler transport",
    },
    status: statusInfo.status,
    statusEvidence: statusInfo.evidence,
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
