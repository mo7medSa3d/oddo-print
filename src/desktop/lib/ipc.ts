/**
 * Typed IPC boundary between the desktop WebView and the Rust backend.
 *
 * All Tauri-specific knowledge lives in this module; the React view only calls
 * these domain-level functions and never touches `invoke`/`listen` directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodeDiagnosticResult, type DiagnosticResult } from "../../shared/diagnostic-test";

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
    if (parsed.username || parsed.password) {
      throw new Error("Gateway URL cannot include embedded credentials");
    }
    // Match the packaged Tauri transport policy (commands.rs
    // normalize_gateway_url): remote Gateways must use HTTPS; plain HTTP is
    // accepted only for local development hosts.
    if (parsed.protocol.toLowerCase() === "http:") {
      const host = parsed.hostname.toLowerCase();
      const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
      if (!local) {
        throw new Error("Gateway URL must use HTTPS for remote Gateways");
      }
    }
    if (parsed.pathname !== "/") throw new Error("Gateway URL must use the origin root");
    if (parsed.search || parsed.hash) {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface GatewayResponse {
  status: number;
  body: string;
}

function gatewayErrorMessage(body: string, fallback: string): string {
  const raw = body.trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["error", "message", "reason"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    // JSON without an operator-facing message (for example {"ok":false})
    // is machine data, not useful UI copy. Preserve the HTTP-aware fallback.
    return fallback;
  } catch {
    // Plain-text Gateway errors remain useful when they are already concise.
  }
  return raw.length <= 512 ? raw : fallback;
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
    if (parsed && typeof parsed === "object") {
      if (typeof readApiField(parsed, "code") === "string") err.code = readApiField(parsed, "code") as string;
      if (typeof readApiField(parsed, "entitlement") === "string") err.entitlement = readApiField(parsed, "entitlement") as string;
      if (readApiField(parsed, "upgradeRequired") === true) err.upgradeRequired = true;
      const limit = readApiField(parsed, "limit");
      if (typeof limit === "number" || limit === "unlimited") err.limit = limit;
      const used = readApiField(parsed, "used");
      if (typeof used === "number") err.used = used;
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
    return { status: response.status, body: await response.text() };
  }
  const responseEnvelope = await invoke<string>("gateway_agent_request", {
    args: { path, method, body: body ?? null, expected_origin: base, idempotency_key: idempotencyKey ?? null },
  });
  const response = JSON.parse(responseEnvelope) as Partial<GatewayResponse>;
  if (typeof response.status !== "number" || typeof response.body !== "string") {
    throw new Error("Invalid Gateway response envelope");
  }
  return { status: response.status, body: response.body };
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

export async function closeApp(): Promise<void> {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
      return;
    } catch {
      // Fallback if window API is unavailable
    }
  }
  if (typeof window !== "undefined") {
    window.close();
  }
}

export interface PrinterInfo {
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
  network_address?: string;
  networkAddress?: string;
  port?: number | null;
  status: string;
  lastSeenAt?: string | null;
  reportedStatus?: string | null;
  freshness?: "fresh" | "stale" | "missing";
  enabled: boolean;
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
}



export async function fetchGatewayAgents(
  gatewayUrl: string,
): Promise<Array<{ id: string; name: string; status?: string; lifecycle?: string; lastSeenAt?: string | null; staleThresholdSeconds?: number | null }>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  // The packaged desktop authenticates with the paired Agent through its
  // native CLI. There is no Manager token or password in the WebView.
  const { status, body } = await gatewayConsoleRequest(base, "/api/agents", "GET", {});
  if (status < 200 || status >= 300) {
    throw gatewayHttpError(status, body, "agents fetch failed (" + status + ")");
  }
  return JSON.parse(body) as Array<{ id: string; name: string; status?: string; lifecycle?: string; lastSeenAt?: string | null; staleThresholdSeconds?: number | null }>;
}

export async function fetchGatewayPrinters(gatewayUrl: string): Promise<PrinterInfo[]> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const { status, body } = await gatewayConsoleRequest(base, "/api/printers", "GET", {});
  if (status < 200 || status >= 300) {
    throw gatewayHttpError(status, body, "printers fetch failed (" + status + ")");
  }
  const rows = JSON.parse(body) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const config = row.config && typeof row.config === "object"
      ? row.config as Record<string, unknown>
      : {};
    const numberOrNull = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const stringOrUndefined = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value : undefined;
    // The Gateway /api/printers rows are camelCase (Drizzle column names) and the
    // Tauri discover_printers command is camelCase too, so the snake_case keys
    // below are synthesized from config and, for the row-level fields, from the
    // camelCase row as well. Reading only snake_case left connectionType /
    // printerType / deviceClass / spoolerName undefined for every real printer.
    const rowString = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const v = stringOrUndefined(row[key]);
        if (v) return v;
      }
      return undefined;
    };
    return {
      ...row,
      enabled: row.lifecycle === "active",
      endpoint: rowString("endpoint") ?? stringOrUndefined(config.address),
      spooler_name:
        rowString("spooler_name", "spoolerName") ?? stringOrUndefined(config.spooler_name),
      network_address:
        rowString("network_address", "networkAddress") ?? stringOrUndefined(config.ip),
      port: numberOrNull(row.port) ?? numberOrNull(config.port),
      usbVid: row.usbVid != null ? String(row.usbVid) : config.vid != null ? String(config.vid) : undefined,
      usbPid: row.usbPid != null ? String(row.usbPid) : config.pid != null ? String(config.pid) : undefined,
      usbSerial: row.usbSerial != null ? String(row.usbSerial) : config.serial != null ? String(config.serial) : undefined,
    };
  }) as unknown as PrinterInfo[];
}

function networkConfigFromEndpoint(endpoint: string, protocol = ""): { ip: string; port: number } {
  const raw = endpoint.trim();
  const normalizedProtocol = protocol.trim().toLowerCase();
  const allowedPorts = normalizedProtocol === "ipp" ? new Set([80, 443, 631]) : new Set([9100]);
  const portError = normalizedProtocol === "ipp"
    ? "Network IPP printer endpoint port must be 80, 443, or 631"
    : "Network printer endpoint port must be 9100";
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close <= 1 || raw.charAt(close + 1) !== ":") throw new Error("Network printer endpoint must be host:9100");
    const ip = raw.slice(1, close);
    const port = Number(raw.slice(close + 2));
    if (!Number.isInteger(port) || !allowedPorts.has(port)) throw new Error(portError);
    return { ip, port };
  }
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) throw new Error("Network printer endpoint must be host:port");
  const ip = raw.slice(0, idx);
  const port = Number(raw.slice(idx + 1));
  if (!ip || !Number.isInteger(port) || !allowedPorts.has(port)) throw new Error(portError);
  return { ip, port };
}

export function parseUsbIdentifier(value: string): number {
  const raw = value.trim();
  if (!/^(?:[0-9]+|0x[0-9a-f]{1,4})$/i.test(raw)) throw new Error("USB identifier must be decimal or 0x-prefixed hexadecimal");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error("USB identifier must be between 0 and 65535");
  return parsed;
}

export async function registerGatewayPrinter(
  gatewayUrl: string,
  req: RegisterPrinterRequest & { agentId: string },
): Promise<PrinterInfo> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const config: Record<string, unknown> = {};
  const connectionType = req.connectionType.toLowerCase();

  if (connectionType === "network") {
    const network = networkConfigFromEndpoint(req.endpoint || "", req.protocol || "");
    config.ip = network.ip;
    config.port = network.port;
  } else if (connectionType === "spooler") {
    const queue = (req.spoolerName || req.endpoint || "").trim();
    if (!queue) throw new Error("Spooler printer name is required");
    config.spooler_name = queue;
    config.address = queue;
    const passthrough = [...new Set((req.spoolerPassthroughProtocols ?? []).filter((value) => value === "raw" || value === "escpos"))];
    config.passthrough_protocols = passthrough;
    if (req.virtualSpoolerTest === true) {
      if (passthrough.length) throw new Error("Virtual Windows spooler test does not accept RAW passthrough");
      config.virtual_spooler_test = true;
    }
  } else if (connectionType === "usb") {
    if (req.usbVid) config.vid = parseUsbIdentifier(req.usbVid);
    if (req.usbPid) config.pid = parseUsbIdentifier(req.usbPid);
    if (req.usbSerial) config.serial = req.usbSerial;
    if (req.spoolerName) config.spooler_name = req.spoolerName;
    if (req.endpoint) config.address = req.endpoint;
  } else if (connectionType === "ipp" || connectionType === "ipps") {
    const address = (req.endpoint || "").trim();
    if (!address) throw new Error("IPP printer URL is required");
    config.address = address;
  } else {
    if (req.endpoint) config.address = req.endpoint.trim();
  }

  const headers = { "Content-Type": "application/json" };
  const payload = {
    name: req.name.trim(),
    agentId: req.agentId,
    connectionType,
    protocol: req.protocol || (connectionType === "spooler" ? "spooler" : "unknown"),
    printerType: req.virtualSpoolerTest === true ? "virtual" : req.printerType || "physical",
    config,
  };
  // An explicit opt-in for a locally discovered software spooler uses the
  // paired Agent's own credentials, never a Manager session. The Gateway
  // enforces Agent/tenant ownership and the Windows service verifies the
  // queue before allowing jobs. Mere Desktop discovery cannot enable it.
  if (req.virtualSpoolerTest && (connectionType !== "spooler" ||
      payload.printerType !== "virtual" || !config.spooler_name ||
      (config.passthrough_protocols as string[] | undefined)?.length)) {
    throw new Error("Virtual test requires a local software spooler without RAW passthrough");
  }
  const { status, body } = await gatewayConsoleRequest(
    base, "/api/printers", "POST", headers, JSON.stringify(payload),
  );
  if (status < 200 || status >= 300) {
    throw gatewayHttpError(status, body, "printer registration failed (" + status + ")");
  }
  return JSON.parse(body) as PrinterInfo;
}

export interface DiscoverResult {
  printers: PrinterInfo[];
  virtualPrinters: PrinterInfo[];
  errors: string[];
}

export function getPrinters(): Promise<PrinterInfo[]> {
  return invoke<PrinterInfo[]>("get_printers");
}

export function discoverPrinters(): Promise<DiscoverResult> {
  return invoke<DiscoverResult>("discover_printers");
}

export async function testGatewayPrinter(
  gatewayUrl: string,
  printerId: string,
  idempotencyKey?: string,
): Promise<DiagnosticResult> {
  const base = normalizeGatewayUrl(gatewayUrl);
  // Paired Agent credentials are scoped by the Gateway to this Agent's
  // printer. Never prompt for or forward a separate Manager password.
  const { status, body } = await gatewayConsoleRequest(
    base,
    "/api/printers/" + encodeURIComponent(printerId) + "/test-print",
    "POST",
    {},
    undefined,
    idempotencyKey,
  );
  if (status < 200 || status >= 300) {
    // Agent credentials stay in the paired native CLI and are never exposed
    // to the WebView; preserve Gateway status for precise operator feedback.
    throw gatewayHttpError(status, body, "Gateway test print failed (" + status + ")");
  }
  return decodeDiagnosticResult(JSON.parse(body), printerId);
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
  virtualSpoolerTest?: boolean;
}

export function registerPrinter(req: RegisterPrinterRequest): Promise<string> {
  return invoke<string>("register_printer", { request: req });
}

export interface AutostartStatus {
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
  return JSON.parse(body) as Record<string, unknown>[];
}

/** Tray menu "Restart Agent" event. Returns the unlisten function. */
export function onTrayRestartAgent(handler: () => void): Promise<UnlistenFn> {
  return listen("tray:restart_agent", handler);
}

/** Tray menu navigation event ("#gateway" | "#agent" | "#pair" | "#settings"). */
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
    if (data.ok !== true || data.service !== "yaseir-print-gateway") {
      throw new Error("Gateway probe returned an unexpected service response");
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.message === "Gateway probe returned an unexpected service response") throw error;
    throw new Error("Gateway probe response was not valid JSON");
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
