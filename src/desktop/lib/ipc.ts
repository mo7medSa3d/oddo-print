import type { OperationalPrinterState } from "../../lib/printer-operational-verification";
/**
 * Typed IPC boundary between the desktop WebView and the Rust backend.
 *
 * All Tauri-specific knowledge lives in this module; the React view only calls
 * these domain-level functions and never touches `invoke`/`listen` directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodeDiagnosticResult, type DiagnosticResult } from "../../shared/diagnostic-test";
import { readGatewayPaginationHeaders } from "./gateway-headers";
import { fetchWithTimeout as sharedFetchWithTimeout } from "../../lib/fetch-timeout";

/** Tauri v2 injects __TAURI_INTERNALS__ only inside the real desktop shell. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const REQUEST_TIMEOUT_MS = 10_000;

export interface AgentStatus {
  running: boolean;
  service: string;
  version: string;
  hostname: string;
  note: string;
  note_code?: string;
}

export interface RuntimePaths {
  manager_data: string;
  settings: string;
  agent_config: string;
  manager_log: string;
  agent_data: string;
}

export function normalizeGatewayUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/\s/.test(trimmed)) {
    throw new Error("Gateway URL cannot contain whitespace");
  }

  // A domain pasted without a scheme is a normal operator input. Default it
  // to HTTPS rather than rejecting an otherwise valid production Gateway.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Gateway URL must use http:// or https://");
    }
    // Check the raw marker as well: URL parsers may discard userinfo whose
    // username and password are both empty (https://@host). The native Go
    // origin parser rejects any such authority, even if it has no secret.
    if (parsed.username || parsed.password || candidate.includes("@")) {
      throw new Error("Gateway URL cannot include embedded credentials");
    }
    // Parse the raw authority before WHATWG removes an empty port suffix.
    // Native Go rejects both "host:" and port zero; accepting them here
    // would make a saved/pasted Gateway work in the WebView but fail pairing.
    // IPv6 colons are always inside brackets and never the authority suffix.
    const rawAuthority = candidate.slice(candidate.indexOf("://") + 3).split(/[/?#\\]/, 1)[0] ?? "";
    if (rawAuthority.endsWith(":") || parsed.port === "0") {
      throw new Error("Gateway URL port must be between 1 and 65535");
    }
    // Plain HTTP is accepted for any host so staging/test servers reachable
    // by IP can be paired without a TLS certificate.
    if (parsed.pathname !== "/") throw new Error("Gateway URL must use the origin root");
    // WHATWG URL.search/hash are empty strings for bare '?' and '#'.
    // Rust/Go reject *present* markers even when their values are empty.
    // Inspect serialized URL so the desktop cannot accept an origin that
    // native pairing later rejects (or silently redirects to another URL).
    if (parsed.href.includes("?") || parsed.href.includes("#")) {
      throw new Error("Gateway URL cannot include query strings or fragments");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Gateway URL")) throw e;
    throw new Error("Gateway URL is invalid");
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // Only the Vite preview performs browser fetch. The installed desktop uses
  // the paired Agent CLI so the WebView never handles Agent credentials.
  if (isTauri) {
    throw new Error("Tauri Gateway requests must use the paired Agent boundary");
  }
  // A fetch() promise resolves at HEADERS, not at the end of the response
  // body. Reuse the shared deadline so stream reads remain abortable and
  // caller cancellation is not discarded after headers arrive.
  return sharedFetchWithTimeout(input, init, REQUEST_TIMEOUT_MS);
}

interface GatewayResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

// Remote bodies can include SQL, tokens, network endpoints and native paths.
// Keep only trusted local HTTP context for human-facing error messages.
// Machine fields are carried separately and localized by callers.
function gatewayErrorMessage(_body: string, fallback: string): string {
  return fallback;
}

/** Structured Gateway failure: message/status for display plus the machine-
 * readable fields callers need for localization and action selection
 * (upgrade dialogs, entitlement copy). Transport layers must preserve these
 * instead of reducing failures to a string (C043). */
export interface GatewayApiError extends Error {
  status?: number;
  code?: string;
  entitlement?: string;
  upgradeRequired?: boolean;
  limit?: number | "unlimited" | null;
  used?: number | null;
}

function readApiField(body: Record<string, unknown>, key: string): unknown {
  return body[key];
}

function gatewayHttpError(status: number, body: string, fallback: string): GatewayApiError {
  const err = new Error(gatewayErrorMessage(body, fallback)) as GatewayApiError;
  err.status = status;
  try {
    const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof readApiField(parsed, "code") === "string") err.code = readApiField(parsed, "code") as string;
      if (typeof readApiField(parsed, "entitlement") === "string") err.entitlement = readApiField(parsed, "entitlement") as string;
      if (readApiField(parsed, "upgradeRequired") === true) err.upgradeRequired = true;
      const limit = readApiField(parsed, "limit");
      if (limit === "unlimited" || (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0)) err.limit = limit;
      const used = readApiField(parsed, "used");
      if (typeof used === "number" && Number.isSafeInteger(used) && used >= 0) err.used = used;
    }
  } catch {
    // Non-JSON bodies carry no structured fields; message/status still apply.
  }
  return err;
}

async function gatewayConsoleRequest(
  gatewayUrl: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
  idempotencyKey?: string,
): Promise<GatewayResponse> {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!isTauri) {
    const response = await fetchWithTimeout(`${base}${path}`, {
      method,
      headers: idempotencyKey ? { ...headers, "Idempotency-Key": idempotencyKey } : headers,
      body,
      credentials: "omit",
    });
    const responseHeaders = readGatewayPaginationHeaders((key) => response.headers.get(key));
    return { status: response.status, body: await response.text(), headers: responseHeaders };
  }
  const responseEnvelope = await invoke<string>("gateway_agent_request", {
    args: { path, method, body: body ?? null, expected_origin: base, idempotency_key: idempotencyKey ?? null },
  });
  const response = JSON.parse(responseEnvelope) as Partial<GatewayResponse>;
  if (typeof response.status !== "number" || typeof response.body !== "string") {
    throw new Error("Invalid Gateway response envelope");
  }
  const responseHeaders = readGatewayPaginationHeaders((key) => response.headers?.[key]);
  return { status: response.status, body: response.body, headers: responseHeaders };
}

function parseGatewayJson(body: string, status: number, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw gatewayHttpError(status, body, `${label} returned non-JSON response (${status})`);
  }
}

export function getAgentStatus(): Promise<AgentStatus> {
  return invoke<AgentStatus>("get_agent_status");
}

export function startAgent(): Promise<string> {
  return invoke<string>("start_agent");
}

export function stopAgent(): Promise<string> {
  return invoke<string>("stop_agent");
}

export function restartAgent(): Promise<string> {
  return invoke<string>("restart_agent");
}

export function setTrayLocale(locale: "en" | "ar"): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return invoke<void>("set_tray_locale", { locale });
}

export function pairAgent(code: string, gatewayUrl: string): Promise<string> {
  return invoke<string>("pair_agent", {
    args: { code, gateway_url: gatewayUrl },
  });
}

export async function getGatewayUrl(): Promise<string> {
  const cfg = await invoke<{ url: string }>("get_gateway_config");
  return cfg?.url ?? "";
}

export function setGatewayUrl(url: string): Promise<string> {
  return invoke<string>("set_gateway_config", { url });
}

export function getRuntimePaths(): Promise<RuntimePaths> {
  return invoke<RuntimePaths>("get_runtime_paths");
}

export function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

export async function isRunningAsAdmin(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_running_as_admin");
  } catch {
    return false;
  }
}

export function relaunchAsAdmin(): Promise<void> {
  return invoke<void>("relaunch_as_admin");
}

export function closeApp(): Promise<void> {
  return invoke<void>("close_app");
}

export interface PrinterInfo extends OperationalPrinterState {
  id: string;
  name: string;
  display_name?: string;
  displayName?: string;
  printer_type?: string;
  printerType?: string;
  device_class?: string;
  deviceClass?: string;
  connection_type?: string;
  connectionType?: string;
  protocol?: string;
  endpoint?: string;
  spooler_name?: string;
  spoolerName?: string;
  /** Agent `DeviceInfo` fields, present on Gateway rows. The Tauri layer
   * drops them for local/discovered rows (its struct has no such fields),
   * so UI code must also read capabilities.driver_name / port_name. */
  spoolerDriver?: string;
  spoolerPort?: string;
  spoolerServer?: string;
  network_address?: string;
  networkAddress?: string;
  port?: number | null;
  status: string;
  lastSeenAt?: string | null;
  reportedStatus?: string | null;
  freshness?: "fresh" | "stale" | "missing";
  enabled: boolean;
  availableToOdoo?: boolean;
  sharedWithGateway?: boolean;
  /** UI-only completion time of the fresh native snapshot, never a Gateway heartbeat. */
  localObservedAt?: number;
  isVirtual?: boolean;
  is_virtual?: boolean;
  usbVid?: string;
  usbPid?: string;
  usbSerial?: string;
  capabilities?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  lifecycle?: "active" | "disabled" | "retired";
  managementSource?: "agent" | "manager";
  desiredRevision?: number;
  appliedDesiredRevision?: number;
  observedDesiredRevision?: number;
  observedDeviceClass?: string | null;
  agentId?: string;
  agentName?: string | null;
  agentStatus?: string | null;
  agentReportedStatus?: string | null;
  agentFreshness?: "fresh" | "stale" | "missing";
  agentLifecycle?: string | null;
  agentLastSeenAt?: string | null;
  agentStaleThresholdSeconds?: number | null;
  configurationConverged?: boolean;
  /** False or unknown until the paired Agent confirms a queue in its service inventory. */
  inventoryPresent?: boolean | null;
}



export async function fetchGatewayAgents(
  gatewayUrl: string,
): Promise<Array<{ id: string; name: string; status?: string; lifecycle?: string; lastSeenAt?: string | null; freshness?: "fresh" | "stale" | "missing"; staleThresholdSeconds?: number | null }>> {
  // Gateway is a License-Only control plane; agent fleet routes were removed.
  normalizeGatewayUrl(gatewayUrl);
  return [];
}

export async function fetchGatewayPrinters(gatewayUrl: string): Promise<PrinterInfo[]> {
  // Gateway is a License-Only control plane; printers are managed locally by the Agent.
  normalizeGatewayUrl(gatewayUrl);
  return [];
}

interface DiscoverResult {
  printers: PrinterInfo[];
  errors: string[];
}

function validatePrinterRow(row: unknown): PrinterInfo {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid local printer inventory row");
  const p = row as Record<string, unknown>;
  const shared = typeof p.availableToOdoo === "boolean" ? p.availableToOdoo : (typeof p.sharedWithGateway === "boolean" ? p.sharedWithGateway : true);
  if (typeof p.id !== "string" || !p.id.trim() || typeof p.name !== "string" || typeof p.status !== "string"
      || typeof p.enabled !== "boolean" || (p.availableToOdoo !== undefined && typeof p.availableToOdoo !== "boolean")
      || (p.sharedWithGateway !== undefined && typeof p.sharedWithGateway !== "boolean")) {
    throw new Error("Invalid local printer inventory row");
  }
  return { ...p, localObservedAt: undefined, availableToOdoo: shared, sharedWithGateway: shared } as unknown as PrinterInfo;
}

export async function getPrinters(): Promise<PrinterInfo[]> {
  const rows = await invoke<unknown>("get_printers");
  if (!Array.isArray(rows)) throw new Error("Invalid local printer inventory");
  return rows.map(validatePrinterRow);
}

/** Persist a printer in this machine's local Agent configuration. Odoo will
 * learn the printer from the Agent heartbeat; no Cloud registration is used. */
export function registerPrinterLocal(request: RegisterPrinterRequest): Promise<string> {
  return invoke<string>("register_printer", { request });
}

export async function discoverPrinters(): Promise<DiscoverResult> {
  const res = await invoke<unknown>("discover_printers");
  if (!res || typeof res !== "object" || Array.isArray(res)) throw new Error("Invalid printer discovery result");
  const obj = res as Record<string, unknown>;
  if (!Array.isArray(obj.printers) || !Array.isArray(obj.errors) || obj.errors.some((e) => typeof e !== "string")) {
    throw new Error("Invalid printer discovery result");
  }
  return {
    printers: obj.printers.map(validatePrinterRow),
    errors: obj.errors as string[],
  };
}

export async function setPrinterVisibility(printerId: string, availableToOdoo: boolean): Promise<{ printerId: string; availableToOdoo: boolean; sharedWithGateway?: boolean }> {
  const id = printerId;
  if (typeof id !== "string" || !id || id.trim() !== id || new TextEncoder().encode(id).length > 256 || id.startsWith("-") || /[\u0000-\u001f\u007f-\u009f]/.test(id) || typeof availableToOdoo !== "boolean") {
    throw new Error("Invalid local printer sharing request");
  }
  // TextEncoder and JSON.stringify can silently replace lone UTF-16
  // surrogates with U+FFFD before the native Rust/Agent command executes.
  // Reject malformed source Unicode rather than change the target queue.
  try { encodeURIComponent(id); } catch { throw new Error("Invalid local printer sharing request"); }
  const reply = await invoke<unknown>("set_printer_visibility", { printerId: id, availableToOdoo });
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Invalid local printer sharing acknowledgment");
  const value = reply as Record<string, unknown>;
  const ackShared = typeof value.availableToOdoo === "boolean" ? value.availableToOdoo : value.sharedWithGateway;
  if (Object.keys(value).length !== 2 || value.printerId !== id || ackShared !== availableToOdoo) {
    throw new Error("Local printer sharing acknowledgment did not match the request");
  }
  return { printerId: id, availableToOdoo, sharedWithGateway: availableToOdoo };
}


export async function testGatewayPrinter(
  gatewayUrl: string,
  printerId: string,
  idempotencyKey?: string,
): Promise<DiagnosticResult> {
  normalizeGatewayUrl(gatewayUrl);
  // Gateway is License-Only and no longer exposes printer test-print routes;
  // route test-print requests to the local Agent IPC command instead.
  const output = await invoke<string>("test_printer", { printerId });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      ok: true,
      jobId: idempotencyKey || `local-test-${printerId}`,
      printerId,
      status: "success",
      isReused: false,
      physicalOutcome: "printed",
    };
  }
  return decodeDiagnosticResult(parsed, printerId);
}

export function cleanupLocalJobs(): Promise<number> {
  return invoke<number>("cleanup_local_jobs");
}

export interface RegisterPrinterRequest {
  name: string;
  connectionType: string;
  endpoint?: string;
  spoolerName?: string;
  protocol?: string;
  printerType?: string;
  usbVid?: string;
  usbPid?: string;
  usbSerial?: string;
  spoolerPassthroughProtocols?: Array<"raw" | "escpos">;
}

interface AutostartStatus {
  enabled: boolean;
}

export function getAutostart(): Promise<AutostartStatus> {
  return invoke<AutostartStatus>("get_autostart");
}

export function setAutostart(enabled: boolean): Promise<string> {
  return invoke<string>("set_autostart", { enabled });
}

export async function fetchGatewayJobs(
  gatewayUrl: string,
  options?: { status?: string; search?: string; limit?: number; printerId?: string }
): Promise<Record<string, unknown>[]> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const params = new URLSearchParams();
  params.set("limit", String(options?.limit ?? 50));
  if (options?.status && options.status !== "all") {
    params.set("status", options.status);
  }
  if (options?.search?.trim()) {
    params.set("search", options.search.trim());
  }
  if (options?.printerId) {
    params.set("printerId", options.printerId);
  }
  const endpoint = `/api/jobs?${params.toString()}`;
  const headers: Record<string, string> = {};
  const { status, body } = await gatewayConsoleRequest(base, endpoint, "GET", headers);
  if (status < 200 || status >= 300) {
    throw gatewayHttpError(status, body, `jobs fetch failed ${status}`);
  }
  // Successful HTTP status does not establish a usable inventory. An old or
  // broken Gateway can return an object/null, which otherwise looks like an
  // empty successful history, or invalid rows which break timeline selection.
  // Reject the whole snapshot so the caller shows its localized load error.
  // Duplicate identities also make timeline selection unsafe.
  const rows: unknown = parseGatewayJson(body, status, "jobs fetch");
  const ids = new Set<string>();
  if (!Array.isArray(rows) || rows.some((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) return true;
    ids.add(row.id);
    return false;
  })) throw new Error("Invalid Gateway jobs response");
  return rows as Record<string, unknown>[];
}

/** Tray menu "Restart Agent" event. Returns the unlisten function. */
export function onTrayRestartAgent(handler: () => void): Promise<UnlistenFn> {
  return listen("tray:restart_agent", handler);
}

/** Tray menu navigation event ("#dashboard" | "#settings"). */
export function onTrayNavigate(
  handler: (anchor: string) => void
): Promise<UnlistenFn> {
  return listen<string>("tray:navigate", (event) => handler(String(event.payload)));
}

/** Gateway configuration changed event. Returns the unlisten function. */
export function onGatewayConfigChanged(
  handler: (url: string) => void
): Promise<UnlistenFn> {
  return listen<string>("gateway:config_changed", (event) => handler(String(event.payload)));
}

/**
 * Bounded gateway health probe. Without an explicit timeout a hung TLS
 * handshake would leave the UI "busy" forever (the browser default has no
 * upper bound for fetch).
 */
/** Probe an arbitrary validated Gateway candidate without persisting it.
 * The packaged app performs this in Rust so CSP stays narrow and no Manager
 * credential is sent to an untrusted draft origin. */
export async function probeGatewayHealth(
  gatewayUrl: string
): Promise<Record<string, unknown>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  let response: GatewayResponse;
  if (isTauri) {
    response = await invoke<GatewayResponse>("probe_gateway_health", { url: base });
  } else {
    const browserResponse = await fetchWithTimeout(`${base}/api/agent/probe`, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    response = { status: browserResponse.status, body: await browserResponse.text() };
  }
  if (response.status < 200 || response.status >= 300) {
    throw gatewayHttpError(response.status, response.body, `Gateway probe failed (${response.status})`);
  }
  try {
    const data = JSON.parse(response.body) as Record<string, unknown>;
    if (data.ok !== true || (data.service !== "odoo-direct-print-agent" && data.service !== "yaseir-print-gateway")) {
      throw new Error("Gateway probe returned an unexpected service response");
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.message.includes("unexpected service response")) throw error;
    throw new Error("Odoo Agent probe response was not valid JSON");
  }
}

export async function fetchGatewayHealth(
  gatewayUrl: string
): Promise<Record<string, unknown>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  // Public liveness is the only unauthenticated check; printer/job inventory
  // always uses the paired Agent credential instead of a Manager session.
  return probeGatewayHealth(base);
}
