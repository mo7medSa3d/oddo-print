import type { PrinterInfo } from "./ipc";
import type { Tone } from "../../shared/job-vocabulary";
import { isVirtualPrinterRecord } from "../../lib/printer-virtual";

export {
  jobLabel,
  jobTone,
  jobGuidance,
  deriveOutcome,
  printerLabel,
  printerTone,
  UNKNOWN_OUTCOME_MARKERS,
} from "../../shared/job-vocabulary";
import {
  deriveOutcome as deriveOutcomeImpl,
  jobLabel as jobLabelImpl,
  jobTone as jobToneImpl,
  printerLabel as printerLabelImpl,
} from "../../shared/job-vocabulary";

/* ============================================================
   Desktop presentation helpers for printers
   ------------------------------------------------------------
   Status vocabulary (icon + colour + label) lives here so every
   page renders the same status the same way.
   ============================================================ */

/* ---------- Virtual / software printer safety net ---------- */
/**
 * DEFENSIVE FILTER ONLY.
 *
 * The authoritative filter runs in the Windows agent: virtual, software and
 * RDP-redirected printers are classified during discovery (port monitor,
 * driver, PnP ids, transport) and never reach the registry, the heartbeat or
 * the Gateway. This helper is the last line of defence so an old record
 * (persisted by a previous version) or a manual registration can never be
 * rendered as a production printer.
 *
 * It shares the Gateway's single classification rule, so it reads the same
 * normalized metadata (and the same port-monitor table) instead of relying on
 * the printer name alone.
 */
export function isVirtualPrinter(p: PrinterInfo | null | undefined): boolean {
  if (!p) return false;
  const anyP = p as unknown as Record<string, unknown>;
  if (anyP.isVirtual === true || anyP.is_virtual === true) return true;
  return isVirtualPrinterRecord({
    name: p.name,
    printerType: p.printer_type,
    connectionType: p.connection_type,
    protocol: p.protocol,
    capabilities: p.capabilities,
  });
}

/** Printers that may be shown, selected for a binding and used for jobs. */
export function isProductionPrinter(p: PrinterInfo): boolean {
  return !isVirtualPrinter(p);
}

/* ---------- Status vocabulary ---------- */

// printerTone/jobTone/printerLabel/jobLabel now come from the SHARED
// vocabulary module (single source of truth with the web console).
export function labelPrinter(status: string): string {
  return printerLabelImpl(status);
}

export function labelJob(status: string, error?: unknown): string {
  return jobLabelImpl(status, deriveOutcomeImpl(status, error == null ? "" : String(error)));
}

export function toneJob(status: string, error?: unknown): Tone {
  return jobToneImpl(status, deriveOutcomeImpl(status, error == null ? "" : String(error)));
}

/* ---------- Human-friendly descriptions ---------- */

export function humanType(p: PrinterInfo): string {
  const t = (p.printer_type || "").toLowerCase();
  if (t === "thermal" || t === "label") return "Thermal";
  if (t === "laser") return "Laser";
  if (t === "inkjet") return "Inkjet";
  if ((p.connection_type || "").toLowerCase() === "usb") return "USB device";
  if (t && t !== "unknown") return t.charAt(0).toUpperCase() + t.slice(1);
  return "Printer";
}

export function humanConnection(p: PrinterInfo): string {
  const c = (p.connection_type || p.printer_type || "").toLowerCase();
  const proto = (p.protocol || "").toLowerCase();
  if (c === "spooler" || proto === "spooler") return "Windows spooler";
  if (c === "usb") return "USB";
  if (c === "ipp" || c === "ipps" || proto === "ipp" || proto === "ipps") return "IPP";
  if (c === "network" || c === "tcp") return "Network (TCP)";
  return "Printer";
}

export function printerEndpoint(p: PrinterInfo): string {
  if (p.network_address) return `${p.network_address}${p.port ? `:${p.port}` : ""}`;
  if (p.endpoint) return p.endpoint;
  return p.spooler_name || "—";
}

/* ---------- Errors ---------- */

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const value = e as Record<string, unknown>;
    for (const key of ["message", "error", "reason"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key] as string;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return "Unknown error";
    }
  }
  return String(e);
}

export function friendlyAgentError(raw: string): string {
  const lower = raw.toLowerCase();

  if (
    lower.includes("load agent config failed") ||
    lower.includes("config.yaml") ||
    lower.includes("access is denied") ||
    lower.includes("permission denied") ||
    lower.includes("administrator privilege")
  ) {
    return "Administrator permission is required to access the local Agent. Reopen Yasser Print Manager as Administrator and try again.";
  }
  if (lower.includes("requires elevation") || lower.includes("elevation required")) {
    return "Administrator permission is required for this operation. Reopen Yasser Print Manager as Administrator and try again.";
  }
  if (lower.includes("pairing code")) {
    return "Pairing could not be completed. Check the pairing code and make sure it has not expired.";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return "The local Agent did not respond in time. Try again.";
  }
  if (lower.includes("connection refused") || lower.includes("failed to connect")) {
    return "The local Agent service is unavailable. Start or restart the Agent, then try again.";
  }
  if (lower.includes("not found") || lower.includes("cannot find the file") || lower.includes("no such file")) {
    return "The local Agent configuration or service is unavailable. Start the Agent service and try again.";
  }
  return "The local Agent could not complete the operation. Try again.";
}

export function friendlyGatewayError(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return "Gateway access is unavailable. Pair this PC with the Gateway and verify the connection.";
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("failed to fetch") ||
    lower.includes("network is unreachable") ||
    lower.includes("econnrefused")
  ) {
    return "The Gateway could not be reached. Check the Gateway URL and network connection, then try again.";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return "The Gateway did not respond in time. Check the connection and try again.";
  }
  if (lower.includes("pairing code")) {
    return "Pairing could not be completed. Check the pairing code and make sure it has not expired.";
  }
  return "The Gateway could not complete the request. Check the connection and try again.";
}

export function friendlyPrinterError(raw: string): string {
  // SAFETY-CRITICAL: an unknown physical outcome must never be reworded into
  // "did not respond" - that phrasing makes operators reprint and
  // double-print. These markers always win, and are never truncated.
  if (/^(AGENT_EXECUTION_TIMEOUT|AGENT_RESTART_DURING_PRINT|JOB_EXPIRED_DURING_PRINT|UNKNOWN_PARTIAL_DELIVERY|UNKNOWN_SUBMISSION_OUTCOME)/.test(raw)) {
    return "Print status is unknown. The printer may have received part or all of the job. Automatic retry is paused to prevent duplicate printing - check the printer before reprinting.";
  }
  const lower = raw.toLowerCase();

  // Agent configuration failures can surface through printer discovery/refresh
  // because the Tauri Gateway transport reads the local Agent config first.
  // Never expose the config path or Windows error text to operators.
  if (lower.includes("load agent config failed") || lower.includes("config.yaml")) {
    return "Administrator permission is required to access the local Agent. Reopen Yasser Print Manager as Administrator and try again.";
  }
  if (lower.includes("connection refused") || lower.includes("dial tcp"))
    return "Could not connect to the printer.";
  if (lower.includes("timeout") || lower.includes("deadline"))
    return "Printer did not respond in time.";
  if (lower.includes("offline")) return "Printer is offline.";
  if (lower.includes("not found") || lower.includes("no such"))
    return "Printer not found.";
  if (lower.includes("access denied") || lower.includes("access is denied") || lower.includes("permission"))
    return "Windows denied access to the printer. Check printer permissions and try again.";

  // Keep unexpected runtime failures operator-safe when they contain a local
  // filesystem path or other backend diagnostics.
  if (
    /[A-Za-z]:\\/.test(raw) ||
    lower.includes("stack backtrace") ||
    lower.includes("panic")
  ) {
    return "The printer operation could not be completed. Check the printer and try again.";
  }

  return raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
}

/* ---------- Job field accessors (gateway payloads are loosely typed) ---------- */

export function jobId(j: Record<string, unknown>): string {
  return String(j.id ?? j.jobId ?? "");
}
export function jobDocType(j: Record<string, unknown>): string {
  return String(j.documentType ?? j.document_type ?? "Document");
}
export function jobPrinterId(j: Record<string, unknown>): string {
  return String(j.printerId ?? "");
}
export function jobDestination(j: Record<string, unknown>): string {
  return String(j.destination ?? "");
}
export function jobStatus(j: Record<string, unknown>): string {
  return String(j.status ?? "");
}
