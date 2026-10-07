import type { PrinterInfo } from "./ipc";
import type { Tone } from "../../shared/job-vocabulary";
import { isVirtualPrinterRecord } from "../../lib/printer-virtual";

export {
  agentLiveView,
  jobLabel,
  jobDisplayLabel,
  jobTone,
  jobGuidance,
  jobFailurePresentation,
  printerObservationFreshness,
  deriveOutcome,
  printerLabel,
  printerTone,
  UNKNOWN_OUTCOME_MARKERS,
} from "../../shared/job-vocabulary";
import {
  agentLiveView,
  deriveOutcome as deriveOutcomeImpl,
  jobDisplayLabel as jobDisplayLabelImpl,
  jobTone as jobToneImpl,
  printerLabel as printerLabelImpl,
} from "../../shared/job-vocabulary";
import { DEFAULT_LOCALE, type Locale } from "../../i18n/config";
import { translate, type MessageKey } from "../../i18n/translate";

/**
 * All operator-facing text in this module goes through the shared catalog so
 * the desktop app speaks the same language as the web console. Every helper
 * takes an optional locale; existing call sites keep working unchanged.
 */
function tr(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

/* ============================================================
   Desktop presentation helpers for printers
   ------------------------------------------------------------
   Status vocabulary (icon + colour + label) lives here so every
   page renders the same status the same way.
   ============================================================ */


export function agentStatusNoteKey(status: { note_code?: unknown; running?: unknown } | null | undefined): MessageKey {
  switch (status?.note_code) {
    case "service_running": return "desktop.agents.note.serviceRunning";
    case "background_running": return "desktop.agents.note.backgroundRunning";
    case "service_status_unavailable": return "desktop.agents.note.serviceStatusUnavailable";
    case "status_check_failed": return "desktop.agents.note.statusCheckFailed";
    case "not_running": return "desktop.agents.note.notRunning";
    default: return status?.running ? "desktop.agents.note.running" : "desktop.agents.note.notRunning";
  }
}

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
/** Heartbeat-aware status of the agent that owns a printer. */
export function printerAgentView(
  printer: PrinterInfo,
  nowMs: number,
  locale: Locale = DEFAULT_LOCALE,
): { tone: Tone; label: string } {
  return agentLiveView(
    {
      status: printer.agentStatus ?? null,
      lastSeenAt: printer.agentLastSeenAt ?? null,
      staleThresholdSeconds: printer.agentStaleThresholdSeconds ?? null,
    },
    nowMs,
    locale,
  );
}

export function printerIsStale(p: PrinterInfo | null | undefined, nowMs = Date.now()): boolean {
  if (!p) return false;
  if (p.freshness === "stale") return true;
  // The snapshot field above ages: recompute from the observation timestamp
  // as the screen stays open so a printer cannot stay green after its
  // observations go stale (C045).
  if (p.lastSeenAt == null) return false;
  const seen = Date.parse(String(p.lastSeenAt));
  if (!Number.isFinite(seen)) return true;
  return printerObservationFreshness(new Date(seen), nowMs) !== "fresh";
}

export function printerDisplayStatus(p: PrinterInfo): string {
  // `/api/printers` already exposes an evidence-based current status. The
  // reportedStatus field is historical/diagnostic evidence only; using it
  // when freshness is stale would resurrect an old Online/Offline claim.
  return p.status || "unknown";
}

export function isVirtualPrinter(p: PrinterInfo | null | undefined): boolean {
  if (!p) return false;
  const anyP = p as unknown as Record<string, unknown>;
  if (anyP.isVirtual === true || anyP.is_virtual === true) return true;
  return isVirtualPrinterRecord({
    name: p.name,
    printerType: p.printer_type || p.printerType,
    connectionType: p.connection_type || p.connectionType,
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
export function labelPrinter(status: string, locale: Locale = DEFAULT_LOCALE): string {
  return printerLabelImpl(status, locale);
}

export function labelJob(status: string, error?: unknown, locale: Locale = DEFAULT_LOCALE): string {
  return jobDisplayLabelImpl(status, error == null ? "" : String(error), locale);
}

export function toneJob(status: string, error?: unknown): Tone {
  return jobToneImpl(status, deriveOutcomeImpl(status, error == null ? "" : String(error)));
}

/* ---------- Human-friendly descriptions ---------- */

export function humanType(p: PrinterInfo, locale: Locale = DEFAULT_LOCALE): string {
  // Device class (thermal/laser/inkjet/label/other/unknown) — NOT printer_type,
  // which is physical/virtual/redirected. Reading printer_type here made the
  // thermal/label/laser/inkjet branches dead code.
  const deviceClass = (p.device_class || p.deviceClass || "").toLowerCase();
  if (deviceClass === "thermal" || deviceClass === "label") return tr(locale, "desktop.type.thermal");
  if (deviceClass === "laser") return tr(locale, "desktop.type.laser");
  if (deviceClass === "inkjet") return tr(locale, "desktop.type.inkjet");
  if ((p.connection_type || p.connectionType || "").toLowerCase() === "usb") return tr(locale, "desktop.type.usb");
  if (deviceClass && deviceClass !== "unknown") return deviceClass.charAt(0).toUpperCase() + deviceClass.slice(1);
  return tr(locale, "desktop.type.printer");
}

export function humanConnection(p: PrinterInfo, locale: Locale = DEFAULT_LOCALE): string {
  const c = (p.connection_type || p.connectionType || "").toLowerCase();
  const proto = (p.protocol || "").toLowerCase();
  if (c === "spooler" || proto === "spooler") return tr(locale, "desktop.connection.spooler");
  if (c === "usb") return tr(locale, "desktop.connection.usb");
  if (c === "ipp" || c === "ipps" || proto === "ipp" || proto === "ipps") return tr(locale, "desktop.connection.ipp");
  if (c === "network" || c === "tcp") return tr(locale, "desktop.connection.network");
  return tr(locale, "desktop.connection.printer");
}

export function printerEndpoint(p: PrinterInfo): string {
  // Accept both wire casings (Tauri camelCase / Gateway camelCase), matching
  // humanType()/humanConnection() in this same module.
  const network = p.network_address || p.networkAddress;
  if (network) return `${network}${p.port ? `:${p.port}` : ""}`;
  if (p.endpoint) return p.endpoint;
  return p.spooler_name || p.spoolerName || "—";
}

/* ---------- Errors ---------- */

export function errMsg(e: unknown, locale: Locale = DEFAULT_LOCALE): string {
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
      return tr(DEFAULT_LOCALE, "desktop.unknownError");
    }
  }
  return String(e);
}

export function friendlyAgentError(raw: string, locale: Locale = DEFAULT_LOCALE): string {
  const lower = raw.toLowerCase();

  if (
    lower.includes("load agent config failed") ||
    lower.includes("config.yaml") ||
    lower.includes("access is denied") ||
    lower.includes("permission denied") ||
    lower.includes("administrator privilege")
  ) {
    return tr(locale, "desktop.agent.adminRequired");
  }
  if (lower.includes("requires elevation") || lower.includes("elevation required")) {
    return tr(locale, "desktop.agent.elevationRequired");
  }
  if (lower.includes("pairing code")) {
    return tr(locale, "desktop.agent.pairingFailed");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return tr(locale, "desktop.agent.timeout");
  }
  if (lower.includes("connection refused") || lower.includes("failed to connect")) {
    return tr(locale, "desktop.agent.unavailable");
  }
  if (lower.includes("not found") || lower.includes("cannot find the file") || lower.includes("no such file")) {
    return tr(locale, "desktop.agent.configUnavailable");
  }
  return tr(locale, "desktop.agent.failed");
}

export function friendlyGatewayError(raw: string, locale: Locale = DEFAULT_LOCALE): string {
  const lower = raw.toLowerCase();

  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return tr(locale, "desktop.gateway.unauthorized");
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("failed to fetch") ||
    lower.includes("network is unreachable") ||
    lower.includes("econnrefused")
  ) {
    return tr(locale, "desktop.gateway.unreachable");
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return tr(locale, "desktop.gateway.timeout");
  }
  if (lower.includes("pairing code")) {
    return tr(locale, "desktop.gateway.pairingFailed");
  }
  return tr(locale, "desktop.gateway.failed");
}

export function friendlyPrinterError(raw: string, locale: Locale = DEFAULT_LOCALE): string {
  // SAFETY-CRITICAL: an unknown physical outcome must never be reworded into
  // "did not respond" - that phrasing makes operators reprint and
  // double-print. These markers always win, and are never truncated.
  if (/^(AGENT_EXECUTION_TIMEOUT|AGENT_RESTART_DURING_PRINT|JOB_EXPIRED_DURING_PRINT|UNKNOWN_PARTIAL_DELIVERY|UNKNOWN_SUBMISSION_OUTCOME)/.test(raw)) {
    return tr(locale, "desktop.printer.unknownOutcome");
  }
  const lower = raw.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication_required")
  ) {
    return tr(locale, "desktop.gateway.unauthorized");
  }

  // Agent configuration failures can surface through printer discovery/refresh
  // because the Tauri Gateway transport reads the local Agent config first.
  // Never expose the config path or Windows error text to operators.
  if (lower.includes("load agent config failed") || lower.includes("config.yaml")) {
    return tr(locale, "desktop.printer.adminRequired");
  }
  if (lower.includes("connection refused") || lower.includes("dial tcp"))
    return tr(locale, "desktop.printer.cannotConnect");
  if (lower.includes("timeout") || lower.includes("deadline"))
    return tr(locale, "desktop.printer.noResponse");
  if (lower.includes("offline")) return tr(locale, "desktop.printer.offline");
  if (lower.includes("not found") || lower.includes("no such"))
    return tr(locale, "desktop.printer.notFound");
  if (lower.includes("access denied") || lower.includes("access is denied") || lower.includes("permission"))
    return tr(locale, "desktop.printer.accessDenied");

  // Keep unexpected runtime failures operator-safe when they contain a local
  // filesystem path or other backend diagnostics.
  if (
    /[A-Za-z]:\\/.test(raw) ||
    lower.includes("stack backtrace") ||
    lower.includes("panic")
  ) {
    return tr(locale, "desktop.printer.operationFailed");
  }

  return raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
}

/* ---------- Job field accessors (gateway payloads are loosely typed) ---------- */

export function jobId(j: Record<string, unknown>): string {
  return String(j.id ?? j.jobId ?? "");
}
export function jobDocType(j: Record<string, unknown>, locale: Locale = DEFAULT_LOCALE): string {
  const raw = j.documentType ?? j.document_type;
  return raw ? String(raw) : tr(locale, "desktop.job.document");
}
export function jobPrinterId(j: Record<string, unknown>): string {
  return String(j.printerId ?? "");
}
export function jobDestination(j: Record<string, unknown>): string {
  return String(j.destination ?? "");
}
/**
 * Read a timestamp field off a job record.
 *
 * JobRecord is `Record<string, unknown>` — the desktop consumes the Gateway's
 * JSON without a generated schema — so `unknown` must be narrowed before it
 * can reach a date formatter. Anything that is not a string or number is
 * reported as absent so the caller renders its placeholder instead of
 * formatting "undefined".
 */
export function jobTimestamp(
  j: Record<string, unknown>,
  key: "createdAt" | "updatedAt",
): string | number | undefined {
  const raw = j[key] ?? (key === "createdAt" ? j.created_at : j.updated_at);
  if (typeof raw === "string" || typeof raw === "number") return raw;
  return undefined;
}

/** Millis for newest-first ordering of bounded job snapshots. */
export function jobTimeMs(j: Record<string, unknown>): number {
  for (const key of ["updatedAt", "createdAt", "updated_at", "created_at"] as const) {
    const raw = j[key];
    const ms = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}
export function jobStatus(j: Record<string, unknown>): string {
  return String(j.status ?? "");
}
