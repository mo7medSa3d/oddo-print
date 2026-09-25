/**
 * Typed IPC boundary between the desktop WebView and the Rust backend.
 *
 * All Tauri-specific knowledge lives in this module; the React view only calls
 * these domain-level functions and never touches `invoke`/`listen` directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tauri v2 injects __TAURI_INTERNALS__ only inside the real desktop shell. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MANAGER_AUTH_EVENT = "odoo-print-manager-auth-changed";
let browserManagerAuthenticated = false;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AgentStatus {
  running: boolean;
  service: string;
  version: string;
  hostname: string;
  note: string;
}

export interface RuntimePaths {
  manager_data: string;
  settings: string;
  agent_config: string;
  manager_log: string;
  agent_data: string;
}

export function normalizeGatewayUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  if (/\s/.test(url)) {
    throw new Error("Gateway URL cannot contain whitespace");
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Gateway URL must use http:// or https://");
  }
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new Error("Gateway URL cannot include embedded credentials");
    }
    // The packaged Tauri app enforces the real transport policy in Rust.
    // The packaged desktop and Rust backend both enforce the same transport policy:
    // remote Gateways must use HTTPS; HTTP is accepted only for local development.
    if (parsed.search || parsed.hash) {
      throw new Error("Gateway URL cannot include query strings or fragments");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("Gateway URL is invalid");
  }
}

async function clearManagerSession(): Promise<void> {
  if (isTauri) {
    await invoke("clear_manager_session");
  } else {
    browserManagerAuthenticated = false;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MANAGER_AUTH_EVENT));
  }
}

export function clearManagerToken(): void {
  if (isTauri) return;
  browserManagerAuthenticated = false;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MANAGER_AUTH_EVENT));
  }
}

export interface ManagerSessionStatus {
  authenticated: boolean;
  expiresAt?: string;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // Browser fetch is intentionally retained only for the Vite preview harness.
  // The packaged Tauri app uses the Rust gateway_request command so CSP can
  // remain narrow and the WebView cannot call arbitrary remote origins.
  if (isTauri) {
    throw new Error("Tauri gateway requests must use gatewayRequest");
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

async function gatewayRequest(
  gatewayUrl: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
  allowSessionRefresh = true,
): Promise<GatewayResponse> {
  const base = normalizeGatewayUrl(gatewayUrl);
  let response: GatewayResponse;
  if (!isTauri) {
    const browserResponse = await fetchWithTimeout(`${base}${path}`, {
      method,
      headers,
      body,
      credentials: "include",
    });
    response = { status: browserResponse.status, body: await browserResponse.text() };
  } else {
    response = await invoke<GatewayResponse>("gateway_request", {
      args: { path, method, headers, body: body ?? null },
    });
  }

  if (
    allowSessionRefresh &&
    (response.status === 401 || response.status === 403) &&
    path !== "/api/auth/manager/login" &&
    path !== "/api/auth/manager/refresh"
  ) {
    try {
      await refreshManagerSession(base);
      return gatewayRequest(base, path, method, headers, body, false);
    } catch {
      await clearManagerSession();
    }
  }

  return response;
}

async function gatewayConsoleRequest(
  gatewayUrl: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<GatewayResponse> {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!isTauri) {
    return gatewayRequest(base, path, method, headers, body);
  }
  const responseEnvelope = await invoke<string>("gateway_agent_request", {
    args: { path, method, body: body ?? null },
  });
  const response = JSON.parse(responseEnvelope) as Partial<GatewayResponse>;
  if (typeof response.status !== "number" || typeof response.body !== "string") {
    throw new Error("Invalid Gateway response envelope");
  }
  return { status: response.status, body: response.body };
}

export async function loginManager(
  gatewayUrl: string,
  username: string,
  password: string,
): Promise<ManagerSessionStatus> {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!username.trim() || !password) throw new Error("Username and password are required");

  const { status, body } = await gatewayRequest(
    base,
    "/api/auth/manager/login",
    "POST",
    { "Content-Type": "application/json", "X-Odoo-Print-Desktop": "1" },
    JSON.stringify({ username: username.trim(), password }),
  );
  const data = (JSON.parse(body || "{}")) as {
    ok?: boolean;
    expiresAt?: string;
    accessToken?: string;
    refreshToken?: string;
    error?: string;
  };
  if (status < 200 || status >= 300 || !data.ok || (isTauri && !data.accessToken)) {
    const err: Error & { status?: number } = new Error(data.error || `Manager login failed (${status})`);
    err.status = status;
    throw err;
  }
  if (!isTauri) browserManagerAuthenticated = true;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MANAGER_AUTH_EVENT));
  return { authenticated: true, expiresAt: data.expiresAt };
}

export async function refreshManagerSession(gatewayUrl: string): Promise<ManagerSessionStatus> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const headers: Record<string, string> = isTauri
    ? { "X-Odoo-Print-Desktop": "1" }
    : {};
  const { status, body } = await gatewayRequest(base, "/api/auth/manager/refresh", "POST", headers);
  const data = JSON.parse(body || "{}") as { ok?: boolean; expiresAt?: string; error?: string };
  if (status < 200 || status >= 300 || !data.ok || typeof data.expiresAt !== "string") {
    const err: Error & { status?: number } = new Error(data.error || `Manager session refresh failed (${status})`);
    err.status = status;
    throw err;
  }
  return { authenticated: true, expiresAt: data.expiresAt };
}

export async function getManagerSession(gatewayUrl: string): Promise<ManagerSessionStatus> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const { status, body } = await gatewayRequest(base, "/api/auth/manager/me", "GET");
  if (status === 401 || status === 403) {
    try {
      return await refreshManagerSession(base);
    } catch {
      await clearManagerSession();
      return { authenticated: false };
    }
  }
  if (status < 200 || status >= 300) throw new Error(`Manager session check failed (${status})`);
  const data = JSON.parse(body) as { authenticated?: boolean; exp?: number };
  if (!data.authenticated || typeof data.exp !== "number") {
    try {
      return await refreshManagerSession(base);
    } catch {
      await clearManagerSession();
      return { authenticated: false };
    }
  }
  return { authenticated: true, expiresAt: new Date(data.exp * 1000).toISOString() };
}

export async function logoutManager(gatewayUrl: string): Promise<void> {
  const base = normalizeGatewayUrl(gatewayUrl);
  try {
    await gatewayRequest(base, "/api/auth/manager/logout", "POST");
  } finally {
    await clearManagerSession();
  }
}

export async function isManagerAuthenticated(): Promise<boolean> {
  if (isTauri) return invoke<boolean>("has_manager_session");
  return browserManagerAuthenticated;
}

export function onManagerAuthChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MANAGER_AUTH_EVENT, handler);
  return () => window.removeEventListener(MANAGER_AUTH_EVENT, handler);
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
  agentLifecycle?: string | null;
  agentLastSeenAt?: string | null;
  configurationConverged?: boolean;
}



async function managerGatewayHeaders(): Promise<Record<string, string>> {
  return {};
}

export async function fetchGatewayAgents(
  gatewayUrl: string,
): Promise<Array<{ id: string; name: string; status?: string; lifecycle?: string; lastSeenAt?: string | null }>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const headers = await managerGatewayHeaders();
  const { status, body } = await gatewayConsoleRequest(base, "/api/agents", "GET", headers);
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(body || "agents fetch failed (" + status + ")");
    err.status = status;
    throw err;
  }
  return JSON.parse(body) as Array<{ id: string; name: string; status?: string; lifecycle?: string; lastSeenAt?: string | null }>;
}

export async function fetchGatewayPrinters(gatewayUrl: string): Promise<PrinterInfo[]> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const headers = await managerGatewayHeaders();
  const { status, body } = await gatewayConsoleRequest(base, "/api/printers", "GET", headers);
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(body || "printers fetch failed (" + status + ")");
    err.status = status;
    throw err;
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
    return {
      ...row,
      enabled: row.lifecycle === "active",
      endpoint: stringOrUndefined(row.endpoint) ?? stringOrUndefined(config.address),
      spooler_name: stringOrUndefined(row.spooler_name) ?? stringOrUndefined(config.spooler_name),
      network_address: stringOrUndefined(row.network_address) ?? stringOrUndefined(config.ip),
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
  } else if (connectionType === "usb") {
    if (req.usbVid) config.vid = Number(req.usbVid);
    if (req.usbPid) config.pid = Number(req.usbPid);
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

  const headers = { "Content-Type": "application/json", ...(await managerGatewayHeaders()) };
  const payload = {
    name: req.name.trim(),
    agentId: req.agentId,
    connectionType,
    protocol: req.protocol || (connectionType === "spooler" ? "spooler" : "unknown"),
    printerType: req.printerType || "physical",
    config,
  };
  const { status, body } = await gatewayConsoleRequest(base, "/api/printers", "POST", headers, JSON.stringify(payload));
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(body || "printer registration failed (" + status + ")");
    err.status = status;
    throw err;
  }
  return JSON.parse(body) as PrinterInfo;
}

export async function updateGatewayPrinter(
  gatewayUrl: string,
  printerId: string,
  patch: Record<string, unknown>,
): Promise<PrinterInfo> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const headers = { "Content-Type": "application/json", ...(await managerGatewayHeaders()) };
  // Printer desired-state mutations are Manager-only at the Gateway HTTP boundary.
  // Use the Rust manager transport, not the Agent console allowlist.
  const { status, body } = await gatewayRequest(
    base,
    "/api/printers/" + encodeURIComponent(printerId),
    "PATCH",
    headers,
    JSON.stringify(patch),
  );
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(body || "printer update failed (" + status + ")");
    err.status = status;
    throw err;
  }
  return JSON.parse(body) as PrinterInfo;
}

export interface DiscoverResult {
  printers: PrinterInfo[];
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
): Promise<Record<string, unknown>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const headers = await managerGatewayHeaders();
  const { status, body } = await gatewayConsoleRequest(
    base,
    "/api/printers/" + encodeURIComponent(printerId) + "/test-print",
    "POST",
    headers,
  );
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(body || "Gateway test print failed (" + status + ")");
    err.status = status;
    throw err;
  }
  return JSON.parse(body) as Record<string, unknown>;
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
  options?: { status?: string; search?: string; limit?: number }
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
  const endpoint = `/api/jobs?${params.toString()}`;
  const headers: Record<string, string> = {};
  const { status, body } = await gatewayConsoleRequest(base, endpoint, "GET", headers);
  if (status === 401 || status === 403) {
    await clearManagerSession();
  }
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(
      body || `jobs fetch failed ${status}`
    );
    err.status = status;
    throw err;
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

const HEALTH_TIMEOUT_MS = 8000;

/**
 * Bounded gateway health probe. Without an explicit timeout a hung TLS
 * handshake would leave the UI "busy" forever (the browser default has no
 * upper bound for fetch).
 */
export async function fetchGatewayHealth(
  gatewayUrl: string
): Promise<Record<string, unknown>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const { status, body } = await gatewayRequest(base, "/api/health", "GET");
  if (status < 200 || status >= 300) throw new Error(`Gateway health failed (${status})`);
  return JSON.parse(body) as Record<string, unknown>;
}
