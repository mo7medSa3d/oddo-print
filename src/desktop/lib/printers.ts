import { documentTypeLabel } from "../../shared/document-label";
import type { PrinterInfo } from "./ipc";
import type { Tone } from "../../shared/job-vocabulary";
import { isUnusableVirtualPrinterRecord, isVirtualPrinterMetadata } from "../../lib/printer-virtual";
import { printerPresentation as gatewayPrinterPresentation, reportedPrinterPresentation, printerStatusDetailCode } from "../../shared/printer-presentation";
import { printerDisplayName } from "../../shared/printer-presentation";
export { printerDisplayName, printerStatusDetail, printerStatusDetailCode } from "../../shared/printer-presentation";

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
  printerObservationFreshness,
  effectivePrinterStatus,
  printerLabel as printerLabelImpl,
} from "../../shared/job-vocabulary";
import { DEFAULT_LOCALE, type Locale } from "../../i18n/config";
import { translate, type MessageKey } from "../../i18n/translate";
import { codeMessageKey } from "../../lib/api-error-keys";

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


type AgentStatusEvidence = { note_code?: unknown; running?: unknown; error?: unknown } | null | undefined;
export type AgentServiceState = "running" | "stopped" | "unknown";

/** A failed SCM query is not proof of a stopped service. A verified owned
 * background process can still establish running independently of SCM. */
export function agentServiceState(status: AgentStatusEvidence): AgentServiceState {
  if (!status || status.error || status.note_code === "status_check_failed") return "unknown";
  if (status.running === true) return "running";
  if (status.note_code === "service_status_unavailable" || status.note_code === "service_ownership_unverified") return "unknown";
  return status.running === false ? "stopped" : "unknown";
}

export function agentStatusNoteKey(status: AgentStatusEvidence): MessageKey {
  if (status?.error) return "desktop.agents.note.statusCheckFailed";
  switch (status?.note_code) {
    case "service_running": return "desktop.agents.note.serviceRunning";
    case "background_running":
    case "background_running_service_missing":
    case "background_running_service_stopped":
      return "desktop.agents.note.backgroundRunning";
    case "service_missing":
    case "service_stopped":
      return "desktop.agents.note.notRunning";
    case "service_status_unavailable": return "desktop.agents.note.serviceStatusUnavailable";
    case "service_ownership_unverified": return "desktop.agents.note.serviceStatusUnavailable";
    case "status_check_failed": return "desktop.agents.note.statusCheckFailed";
    case "not_running": return "desktop.agents.note.notRunning";
    default: return agentServiceState(status) === "running" ? "desktop.agents.note.running"
      : agentServiceState(status) === "stopped" ? "desktop.agents.note.notRunning" : "desktop.agents.note.statusCheckFailed";
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
      lifecycle: printer.agentLifecycle ?? null,
      lastSeenAt: printer.agentLastSeenAt ?? null,
      freshness: printer.agentFreshness ?? null,
      staleThresholdSeconds: printer.agentStaleThresholdSeconds ?? null,
    },
    nowMs,
    locale,
  );
}

export function printerIsStale(p: PrinterInfo | null | undefined, nowMs = Date.now()): boolean {
  if (!p) return false;
  if (isLocalPrinter(p)) return printerObservationFreshness(new Date(p.localObservedAt!), nowMs) !== "fresh";
  if (p.freshness === "stale") return true;
  // The snapshot field above ages: recompute from the observation timestamp
  // as the screen stays open so a printer cannot stay green after its
  // observations go stale (C045).
  if (p.lastSeenAt == null) return false;
  const seen = Date.parse(String(p.lastSeenAt));
  if (!Number.isFinite(seen)) return true;
  return printerObservationFreshness(new Date(seen), nowMs) !== "fresh";
}

export function printerDisplayStatus(p: PrinterInfo, nowMs = Date.now()): string {
  if (isLocalPrinter(p)) {
    const state = printerPresentation(p, undefined, nowMs).state;
    return state === "ready" ? "online" : state === "printing" ? "busy" : state === "attention" ? "error" : "unknown";
  }
  // Even an initially valid printer snapshot ages. Never resurrect the
  // last reported online status when observation evidence is stale or missing.
  // This shared function also handles non-active lifecycle states.
  return effectivePrinterStatus(p, undefined, nowMs);
}

function isLocalPrinter(p: PrinterInfo): boolean {
  return typeof p.localObservedAt === "number" && Number.isFinite(p.localObservedAt);
}

export function isLocalSetupCandidate(p: PrinterInfo): boolean {
  return p.capabilities?.verification === "candidate_only" || p.capabilities?.verification === "device_detected_only";
}

/** Local completion is Windows observation evidence, never Agent heartbeat evidence. */
export function printerPresentation(p: PrinterInfo, agent?: Parameters<typeof gatewayPrinterPresentation>[1], nowMs = Date.now()): ReturnType<typeof gatewayPrinterPresentation> {
  if (!isLocalPrinter(p)) return gatewayPrinterPresentation(p, agent, nowMs);
  const unavailable = () => ({ state: "unavailable" as const, tone: "neutral" as const, labelKey: "printer.presentation.unavailable" as const, reasonKey: "printer.presentation.statusUnavailableReason" as const });
  if (printerObservationFreshness(new Date(p.localObservedAt!), nowMs) !== "fresh"
      || isLocalSetupCandidate(p)) return unavailable();
  if (p.enabled === false) {
    return { state: "attention", tone: "warn", labelKey: "printer.presentation.attention", reasonKey: "printer.presentation.inactiveReason" };
  }
  // A fresh local observation displays the status Windows actually
  // reported (refined by its detail code). Operational verification is an
  // admission gate for Gateway test prints (eligibleGatewayTestPrinterIds)
  // and a separate detail — never a mask over the local printer's state.
  return reportedPrinterPresentation(p.status, printerStatusDetailCode(p));
}

/** Duplicate cloud IDs are conflicting route evidence, even if payloads look
 * identical. Never let Map overwrite a different Agent's printer authority. */
function conflictingCloudPrinterIds(rows: readonly PrinterInfo[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) conflicts.add(row.id);
    seen.add(row.id);
  }
  return conflicts;
}

/** A same-name local queue is never sufficient to adopt Gateway authority.
 * Both Agent observation and Gateway projection must bind the same exact
 * printer ID and cryptographic queue digest. */
function sameLocalCloudPrinterBinding(local: PrinterInfo, cloud: PrinterInfo): boolean {
  const proof = local.capabilities?.operational_verification;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const binding = (proof as Record<string, unknown>).binding_digest;
  return typeof binding === "string" && /^[a-f0-9]{64}$/.test(binding)
    && local.id === cloud.id && (proof as Record<string, unknown>).printer_id === local.id
    && (proof as Record<string, unknown>).logical_queue_key === binding
    && cloud.verificationState === "verified"
    && cloud.verificationBindingDigest === binding && cloud.logicalQueueKey === binding;
}

export function mergePrinterInventories(cloud: PrinterInfo[], local: PrinterInfo[]): PrinterInfo[] {
  const conflicts = conflictingCloudPrinterIds(cloud);
  const conflictingLocalIds = conflictingCloudPrinterIds(local);
  const rows = new Map(cloud.filter((p) => isProductionPrinter(p) && !conflicts.has(p.id)).map((p) => [p.id, p]));
  for (const printer of local.filter((p) => isProductionPrinter(p) && !isLocalSetupCandidate(p))) {
    if (conflictingLocalIds.has(printer.id)) {
      // Two native observations with one ID cannot establish a unique physical
      // queue. Do not display whichever came last as the trusted printer, or
      // let a cloud row with that ID mask the local identity conflict.
      rows.delete(printer.id);
      continue;
    }
    const remote = rows.get(printer.id);
    const matched = remote && printer.availableToOdoo !== false && sameLocalCloudPrinterBinding(printer, remote);
    // Local-only health may be displayed independently even when the Gateway
    // is stale or withheld. Never carry a foreign cloud agentId/verification
    // into that local row; the test-print gate below uses the same proof.
    rows.set(printer.id, matched
      ? { ...remote, ...printer, lifecycle: printer.lifecycle, inventoryPresent: printer.inventoryPresent, availableToOdoo: printer.availableToOdoo ?? true }
      : { ...printer, availableToOdoo: printer.availableToOdoo ?? true });
  }
  return [...rows.values()];
}

/** Unknown native health may be admitted, but local readiness grants no cloud route. */
export function eligibleGatewayTestPrinterIds(cloud: PrinterInfo[], local: PrinterInfo[], connected: boolean, nowMs: number): ReadonlySet<string> {
  const conflictingCloudIds = conflictingCloudPrinterIds(cloud);
  const localById = new Map(local.map(p => [p.id, p]));
  // A duplicate local identity is conflicting evidence; never authorize a
  // cloud test through whichever duplicate happened to be last in the array.
  const conflictingLocalIds = new Set<string>();
  const seenLocalIds = new Set<string>();
  for (const p of local) {
    if (seenLocalIds.has(p.id)) conflictingLocalIds.add(p.id);
    seenLocalIds.add(p.id);
  }
  return new Set(connected ? cloud.filter((p) => {
    if (conflictingCloudIds.has(p.id) || conflictingLocalIds.has(p.id) || p.availableToOdoo === false) return false;
    const native = localById.get(p.id);
    if (native && (native.availableToOdoo === false || isLocalSetupCandidate(native)
      || !sameLocalCloudPrinterBinding(native, p))) return false;
    // Operational verification is not a test-print gate: the Agent probes
    // in the background, and a slow or failing driver measurement must not
    // refuse a test page. Eligibility is identity, sharing, presence and
    // freshness — real, current facts only.
    return isMainInventoryPrinter(p) && p.inventoryPresent === true && !!p.agentId && p.configurationConverged !== false
      && p.agentFreshness !== "stale" && p.agentFreshness !== "missing" && p.freshness !== "stale" && p.freshness !== "missing"
      && printerAgentView(p, nowMs).tone === "ok"
      && printerObservationFreshness(p.lastSeenAt, nowMs) === "fresh";
  }).map((p) => p.id) : []);
}

/** Single advancing-clock projection used by every Desktop status summary. */
export function printerHealthCounts(printers: PrinterInfo[], nowMs = Date.now()) {
  const counts = { ready: 0, printing: 0, attention: 0, unavailable: 0 };
  for (const printer of printers) {
    if (isMainInventoryPrinter(printer)) counts[printerPresentation(printer, undefined, nowMs).state] += 1;
  }
  return { ...counts, online: counts.ready + counts.printing, offline: counts.attention, unknown: counts.unavailable };
}

function toPrinterLike(p: PrinterInfo) {
  const anyP = p as unknown as Record<string, unknown>;
  return {
    name: p.name,
    displayName: p.displayName,
    display_name: p.display_name,
    spoolerName: p.spoolerName,
    spooler_name: p.spooler_name,
    endpoint: p.endpoint,
    port: p.port,
    driverName: typeof anyP.driverName === "string" ? anyP.driverName : undefined,
    printerType: p.printer_type || p.printerType,
    deviceClass: typeof anyP.deviceClass === "string" ? anyP.deviceClass : typeof anyP.device_class === "string" ? anyP.device_class : undefined,
    connectionType: p.connection_type || p.connectionType,
    protocol: p.protocol,
    isVirtual: anyP.isVirtual === true,
    is_virtual: anyP.is_virtual === true,
    capabilities: p.capabilities,
    config: p.config,
  };
}

/** True for any virtual printer (including Microsoft Print to PDF, XPS, CUPS-PDF, Print to File). */
export function isVirtualPrinter(p: PrinterInfo | null | undefined): boolean {
  if (!p) return false;
  return isVirtualPrinterMetadata(toPrinterLike(p));
}

/** Both physical printers and printable virtual printers enter Desktop inventory and sharing.
 * Only unusable stubs (fax, blackhole/nul:, session-redirected queues) are excluded. */
export function isProductionPrinter(p: PrinterInfo): boolean {
  if (!p) return false;
  return !isUnusableVirtualPrinterRecord(toPrinterLike(p));
}

/** Saved absent/inactive devices remain manageable outside the current list. */
export function isMainInventoryPrinter(p: PrinterInfo): boolean {
  if (isLocalPrinter(p)) return isProductionPrinter(p) && !isLocalSetupCandidate(p);
  return isProductionPrinter(p) && p.inventoryPresent !== false && p.enabled !== false && (!p.lifecycle || p.lifecycle === "active");
}

/* ---------- Add-printer picker eligibility (WP4) ---------- */

/**
 * A picker row is eligible when it is a production spooler queue and its
 * agent ownership does not contradict the selected agent. The proven S3
 * bug was demanding `p.agentId === currentAgentId`: local inventory rows
 * (`printers list`) carry NO agentId at all — only `printers discover`
 * injects one as ephemeral session state — so they could never be picked.
 * An absent agentId therefore must NOT disqualify a row; only a present
 * agentId belonging to a different agent record excludes it (and is
 * surfaced as a mismatch warning, not silently dropped).
 */
export function isPickerEligiblePrinter(p: PrinterInfo, currentAgentId: string): boolean {
  return isProductionPrinter(p) && (!p.agentId || p.agentId === currentAgentId);
}

function spoolerQueueName(p: PrinterInfo): string {
  return p.spooler_name || p.spoolerName || "";
}

function capabilityString(p: PrinterInfo, key: string): string {
  const value = p.capabilities?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function configString(p: PrinterInfo, key: string): string {
  const value = p.config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Driver / port for a spooler row. The Agent emits both as first-class
 * `DeviceInfo` fields (spoolerDriver / spoolerPort) AND in the capability
 * bag (driver_name / port_name); the capability bag is the one that
 * survives the Tauri struct for local/discovered rows, so it wins, with
 * the top-level fields and config as fallbacks. Never invented: "" when
 * no source carries the value.
 */
export function spoolerDriverName(p: PrinterInfo): string {
  return capabilityString(p, "driver_name") || (p.spoolerDriver ?? "").trim() || configString(p, "driver_name");
}

export function spoolerPortName(p: PrinterInfo): string {
  return capabilityString(p, "port_name") || (p.spoolerPort ?? "").trim() || configString(p, "port_name");
}

/** One-line picker label: queue name + driver + port + status, omitting
 * whichever parts the Agent did not report. */
export function spoolerRowLabel(p: PrinterInfo, locale: Locale = DEFAULT_LOCALE): string {
  const parts = [printerDisplayName(p, locale)];
  const driver = spoolerDriverName(p);
  const port = spoolerPortName(p);
  if (driver) parts.push(driver);
  if (port) parts.push(port);
  const status = (p.status || "").trim();
  if (status) parts.push(status);
  return parts.join(" · ");
}

export function pickerSpoolerRows(printers: PrinterInfo[], currentAgentId: string): PrinterInfo[] {
  return printers.filter((p) => isPickerEligiblePrinter(p, currentAgentId) && spoolerQueueName(p).trim());
}

/** Production spooler rows owned by a DIFFERENT agent record than the
 * selected one. Excluded from the picker, but the dialog warns about
 * them instead of rendering the same empty-picker hint as "no printers". */
export function pickerAgentMismatchRows(printers: PrinterInfo[], currentAgentId: string): PrinterInfo[] {
  if (!currentAgentId) return [];
  return printers.filter((p) => isProductionPrinter(p) && spoolerQueueName(p).trim()
    && !!p.agentId && p.agentId !== currentAgentId);
}

/** Case-insensitive search over queue name, display name, driver, port
 * and status. An empty query returns every row. */
export function searchSpoolerRows(rows: PrinterInfo[], query: string, locale: Locale = DEFAULT_LOCALE): PrinterInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((p) => [spoolerQueueName(p), printerDisplayName(p, locale), spoolerDriverName(p), spoolerPortName(p), p.status ?? ""]
    .some((value) => value.toLowerCase().includes(q)));
}

type TypedSpoolerNameCheck =
  | { status: "empty"; name: string; suggestion: null }
  | { status: "exact"; name: string; suggestion: null }
  | { status: "agent_mismatch"; name: string; suggestion: string }
  | { status: "near_miss"; name: string; suggestion: string }
  | { status: "unknown"; name: string; suggestion: null };

/**
 * Validate a manually typed Windows queue name. `eligibleRows` are
 * pickable for the selected agent, `mismatchRows` belong to another agent
 * record. Windows queue names match case-insensitively, so a case-only
 * difference is exact; a missing " (2)"-style suffix (or any
 * prefix/substring relation) is a near miss with a suggestion; a name
 * that exists ONLY under another agent record is an agent mismatch.
 * "unknown" is a WARNING, never a hard block: discovery can miss
 * per-user queues, so an undiscovered name may still be real — the
 * dialog must warn, not refuse.
 */
export function validateTypedSpoolerNameAgainst(raw: string, eligibleRows: PrinterInfo[], mismatchRows: PrinterInfo[]): TypedSpoolerNameCheck {
  const name = raw.trim();
  if (!name) return { status: "empty", name, suggestion: null };
  const lower = name.toLowerCase();
  const eligibleQueues = eligibleRows.map((p) => spoolerQueueName(p).trim()).filter(Boolean);
  if (eligibleQueues.some((q) => q.toLowerCase() === lower)) return { status: "exact", name, suggestion: null };
  const mismatch = mismatchRows.map((p) => spoolerQueueName(p).trim()).filter(Boolean)
    .find((q) => q.toLowerCase() === lower);
  if (mismatch) return { status: "agent_mismatch", name, suggestion: mismatch };
  const near = [...eligibleQueues, ...mismatchRows.map((p) => spoolerQueueName(p).trim()).filter(Boolean)]
    .find((q) => q.toLowerCase().includes(lower) || lower.includes(q.toLowerCase()));
  if (near) return { status: "near_miss", name, suggestion: near };
  return { status: "unknown", name, suggestion: null };
}

/**
 * One-click picker fill: choosing a row always fills the spooler name;
 * the printer name is filled from the row's display name only when the
 * user has not already typed a name, so a deliberate custom name is
 * never overwritten. Driver/port are displayed from the row (the
 * Gateway spooler registration carries no driver/port fields, so they
 * are shown, not submitted).
 */
export function applySpoolerSelection(picked: PrinterInfo, currentName: string): { name: string; spoolerName: string } {
  const spoolerName = spoolerQueueName(picked);
  return {
    name: currentName.trim() ? currentName : printerDisplayName(picked),
    spoolerName,
  };
}

/* ---------- Status vocabulary ---------- */

// printerTone/jobTone/printerLabel/jobLabel now come from the SHARED
// vocabulary module (single source of truth with the web console).
export function labelPrinter(status: string, locale: Locale = DEFAULT_LOCALE): string {
  return printerLabelImpl(status, locale);
}

export function labelJob(status: string, error?: unknown, locale: Locale = DEFAULT_LOCALE, output?: { outputMedium?: unknown; outputEvidence?: unknown }): string {
  return jobDisplayLabelImpl(status, error == null ? "" : String(error), locale, output);
}

export function toneJob(status: string, error?: unknown): Tone {
  return jobToneImpl(status, deriveOutcomeImpl(status, error == null ? "" : String(error)));
}

/* ---------- Human-friendly descriptions ---------- */

export function humanType(p: PrinterInfo, locale: Locale = DEFAULT_LOCALE): string {
  // The local CLI retains device classes in printerType; Gateway uses deviceClass.
  const legacyClass = (p.printerType || p.printer_type || "").toLowerCase();
  const deviceClass = (p.device_class || p.deviceClass ||
    (["thermal", "laser", "inkjet", "label"].includes(legacyClass) ? legacyClass : "")).toLowerCase();
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
      return tr(locale, "desktop.unknownError");
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

export function friendlyGatewayError(raw: unknown, locale: Locale = DEFAULT_LOCALE): string {
  // Keep the HTTP status before translating: the response's machine message
  // may omit it (for example INTERNAL_ERROR), but IPC preserves it on Error.
  const failure = raw && typeof raw === "object"
    ? raw as { status?: unknown; message?: unknown }
    : null;
  const status = typeof failure?.status === "number" ? failure.status : undefined;
  const message = typeof raw === "string" ? raw
    : typeof failure?.message === "string" ? failure.message : "";
  const lower = message.toLowerCase();

  if (status !== undefined && status >= 500 && status <= 599) {
    return tr(locale, "desktop.gateway.serverError");
  }
  if (status === 404) return tr(locale, "desktop.gateway.notGateway");

  if (status === 401 || status === 403 || lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return tr(locale, "desktop.gateway.unauthorized");
  }
  if (
    lower.includes("dns") ||
    lower.includes("no such host") ||
    lower.includes("failed to lookup") ||
    lower.includes("name or service not known") ||
    lower.includes("nodename nor servname")
  ) {
    return tr(locale, "desktop.gateway.dns");
  }
  if (
    lower.includes("certificate") ||
    lower.includes("tls") ||
    lower.includes("ssl") ||
    lower.includes("unknown issuer") ||
    lower.includes("cert ")
  ) {
    return tr(locale, "desktop.gateway.tls");
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
  if (
    lower.includes("gateway probe failed (5") ||
    lower.includes("gateway health failed (5") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504")
  ) {
    return tr(locale, "desktop.gateway.serverError");
  }
  if (
    lower.includes("gateway probe failed (404)") ||
    lower.includes("unexpected service response") ||
    lower.includes("probe response was not valid json")
  ) {
    return tr(locale, "desktop.gateway.notGateway");
  }
  if (lower.includes("must use https")) {
    return tr(locale, "desktop.gateway.httpsRequired");
  }
  if (
    lower.includes("gateway url is invalid") ||
    lower.includes("origin root") ||
    lower.includes("query strings or fragments") ||
    lower.includes("embedded credentials") ||
    lower.includes("cannot contain whitespace") ||
    lower.includes("must use http:// or https://") ||
    lower.includes("port must be between")
  ) {
    return tr(locale, "desktop.gateway.invalidUrl");
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

  return tr(locale, "desktop.printer.operationFailed");
}

/**
 * Diagnostic HTTP admission errors are not hardware failures. Use their
 * stable machine codes rather than the unlocalized Gateway error string;
 * a print quota hold is never a printer outage or proof of paper output.
 * An unrecognized/ambiguous response continues to keep the same operation
 * identity in the calling component until a definitive result is observed.
 */
export function friendlyDiagnosticAdmissionError(raw: unknown, locale: Locale = DEFAULT_LOCALE): string {
  const row = raw && typeof raw === "object" ? raw as { status?: unknown; code?: unknown } : null;
  const status = typeof row?.status === "number" ? row.status : null;
  const code = typeof row?.code === "string" ? row.code : undefined;
  if (status === 401) return tr(locale, "diagnostic.authRequired");
  if (code && [
    "CAPABILITY_MISMATCH",
    "PRINTER_NOT_SHARED",
    "PRINT_QUOTA_EXCEEDED",
    "TENANT_ENTITLEMENT_EXCEEDED",
    "TENANT_SUBSCRIPTION_REQUIRED",
    "TENANT_ENTITLEMENT_UNAVAILABLE",
    "TENANT_ENTITLEMENT_CONFIG_ERROR",
  ].includes(code)) {
    const key = codeMessageKey(code);
    if (key) return tr(locale, key);
  }
  if (status === 403) return tr(locale, "diagnostic.permissionDenied");
  if (status === 429) return tr(locale, "errors.tooManyAttempts");
  return tr(locale, "diagnostic.admissionUnknown");
}

/* ---------- Job field accessors (gateway payloads are loosely typed) ---------- */

export function jobId(j: Record<string, unknown>): string {
  return String(j.id ?? j.jobId ?? "");
}
export function jobDocType(j: Record<string, unknown>, locale: Locale = DEFAULT_LOCALE): string {
  const raw = j.documentType ?? j.document_type;
  return documentTypeLabel(raw, locale);
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

export function jobStatus(j: Record<string, unknown>): string {
  return String(j.status ?? "");
}
