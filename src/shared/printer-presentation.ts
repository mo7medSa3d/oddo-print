import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { translate, type MessageKey } from "../i18n/translate";
import { agentLiveView, printerObservationFreshness, type Tone } from "./job-vocabulary";

export type PrinterPresentationState = "ready" | "printing" | "attention" | "unavailable";
type Owner = {
  status?: string | null;
  lifecycle?: string | null;
  lastSeenAt?: Date | string | null;
  freshness?: string | null;
  staleThresholdSeconds?: number | null;
};
type PrinterView = {
  id?: string;
  name?: string | null;
  displayName?: string | null;
  display_name?: string | null;
  spoolerName?: string | null;
  spooler_name?: string | null;
  endpoint?: string | null;
  networkAddress?: string | null;
  network_address?: string | null;
  config?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
  status?: string | null;
  freshness?: string | null;
  lifecycle?: string | null;
  enabled?: boolean;
  inventoryPresent?: boolean | null;
  sharedWithGateway?: boolean;
  lastSeenAt?: Date | string | null;
  agentId?: string | null;
  agentStatus?: string | null;
  agentLifecycle?: string | null;
  agentLastSeenAt?: Date | string | null;
  agentFreshness?: string | null;
  agentStaleThresholdSeconds?: number | null;
};

/** Presentation only: raw health and admission gates keep their own evidence. */
export function printerPresentation(printer: PrinterView, agent?: Owner | null, nowMs = Date.now()): {
  state: PrinterPresentationState; tone: Tone; labelKey: MessageKey; reasonKey: MessageKey;
} {
  const unavailable = (reasonKey: MessageKey) => ({ state: "unavailable" as const, tone: "neutral" as const, labelKey: "printer.presentation.unavailable" as const, reasonKey });
  if (printer.sharedWithGateway === false) return unavailable("printer.presentation.notSharedReason");
  // A paginated Agent list may omit this owner; the printer carries its evidence.
  const owner = agent !== undefined ? agent : printer.agentId || printer.agentStatus != null || printer.agentLastSeenAt != null
    ? { status: printer.agentStatus, lifecycle: printer.agentLifecycle, lastSeenAt: printer.agentLastSeenAt, freshness: printer.agentFreshness, staleThresholdSeconds: printer.agentStaleThresholdSeconds }
    : undefined;
  if (!owner || owner.freshness === "stale" || owner.freshness === "missing" || agentLiveView(owner, nowMs).tone !== "ok") {
    return unavailable("printer.presentation.agentUnavailableReason");
  }
  if (printer.enabled === false || (printer.lifecycle && printer.lifecycle !== "active")) {
    return { state: "attention", tone: "warn", labelKey: "printer.presentation.attention", reasonKey: "printer.presentation.inactiveReason" };
  }
  if (printer.inventoryPresent === false) {
    return unavailable("printer.presentation.inventoryUnavailableReason");
  }
  if (printer.freshness === "stale" || printer.freshness === "missing" || printerObservationFreshness(printer.lastSeenAt, nowMs) !== "fresh") {
    return unavailable("printer.presentation.statusUnavailableReason");
  }
  switch ((printer.status ?? "").trim().toLowerCase()) {
    case "online": case "idle":
      return { state: "ready", tone: "ok", labelKey: "printer.presentation.ready", reasonKey: "printer.presentation.readyReason" };
    case "busy": case "printing":
      return { state: "printing", tone: "info", labelKey: "printer.presentation.printing", reasonKey: "printer.presentation.printingReason" };
    case "offline": case "error": case "paper_out": case "driver_error": case "spooler_error":
      return { state: "attention", tone: "bad", labelKey: "printer.presentation.attention", reasonKey: "printer.presentation.attentionReason" };
    default:
      return unavailable("printer.presentation.statusUnavailableReason");
  }
}

/** Keep operator/Windows queue names intact; opaque registry IDs stay in details. */
export function printerDisplayName(printer: PrinterView, locale: Locale = DEFAULT_LOCALE): string {
  for (const candidate of [printer.name, printer.displayName, printer.display_name, printer.spoolerName, printer.spooler_name, printer.config?.spooler_name]) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim();
    if (name && name !== printer.id && !name.startsWith("\\\\?\\") && !name.startsWith("\\\\.\\") && !/^printer(?:_(?:identity|spooler|usb|net|ep))?_[a-f0-9]{16}$/i.test(name)) return name;
  }
  const address = printer.networkAddress || printer.network_address || printer.config?.ip || printer.endpoint || printer.config?.address || printer.config?.ipp_url;
  if (typeof address === "string" && address.trim() && !address.trim().startsWith("\\\\?\\") && !address.trim().startsWith("\\\\.\\")) {
    let readable = address.trim();
    try {
      const url = new URL(readable);
      if (url.hostname) readable = url.hostname + (url.pathname === "/" ? "" : url.pathname);
    } catch { /* Plain host/queue addresses already have readable text. */ }
    return translate(locale, "printer.presentation.atAddress", { address: readable });
  }
  return translate(locale, "printer.presentation.unnamed");
}

const detailKeys: Record<string, MessageKey> = {
  windows_work_offline: "printer.detail.windows_work_offline",
  windows_offline: "printer.detail.windows_offline",
  windows_server_offline: "printer.detail.windows_server_offline",
  windows_unavailable: "printer.detail.windows_unavailable",
  windows_paused: "printer.detail.windows_paused",
  windows_pending_deletion: "printer.detail.windows_pending_deletion",
  windows_paper_jam: "printer.detail.windows_paper_jam",
  windows_paper_out: "printer.detail.windows_paper_out",
  windows_door_open: "printer.detail.windows_door_open",
  windows_manual_feed: "printer.detail.windows_manual_feed",
  windows_paper_problem: "printer.detail.windows_paper_problem",
  windows_output_bin_full: "printer.detail.windows_output_bin_full",
  windows_no_toner: "printer.detail.windows_no_toner",
  windows_user_intervention: "printer.detail.windows_user_intervention",
  windows_out_of_memory: "printer.detail.windows_out_of_memory",
  windows_page_punt: "printer.detail.windows_page_punt",
  windows_error: "printer.detail.windows_error",
  windows_status_unknown: "printer.detail.windows_status_unknown",
  windows_busy: "printer.detail.windows_busy",
  windows_waiting: "printer.detail.windows_waiting",
  windows_initializing: "printer.detail.windows_initializing",
  windows_toner_low: "printer.detail.windows_toner_low",
  windows_power_save: "printer.detail.windows_power_save",
};

/** Stable Agent detail codes are localized only when details are requested. */
export function printerStatusDetail(printer: PrinterView, locale: Locale = DEFAULT_LOCALE): string {
  const value = printer.capabilities?.status_detail;
  if (typeof value !== "string") return "";
  const detail = value.trim();
  const key = Object.prototype.hasOwnProperty.call(detailKeys, detail) ? detailKeys[detail] : undefined;
  return key ? translate(locale, key) : detail;
}
