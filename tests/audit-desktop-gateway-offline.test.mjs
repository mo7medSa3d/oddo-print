import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

// Exercise the production functions and real catalogs with Node's bundled
// parser. This suite also runs in the existing dependency-free CI lane.
async function load(file, globals = {}, select = (source) => source) {
  const context = vm.createContext({ console, URL, Error, process: { env: { NODE_ENV: "test" } }, ...globals });
  const modules = new Map();
  async function get(path) {
    if (modules.has(path)) return modules.get(path);
    const source = select(await readFile(path, "utf8"), path);
    const loadedModule = new vm.SourceTextModule(stripTypeScriptTypes(source), { context, identifier: path });
    modules.set(path, loadedModule);
    await loadedModule.link((name) => get(resolve(dirname(path), `${name}.ts`)));
    return loadedModule;
  }
  const loadedModule = await get(resolve(file));
  await loadedModule.evaluate();
  return loadedModule.namespace;
}

function slice(source, start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, start);
  const stop = source.indexOf(end, offset);
  assert.ok(stop > offset, end);
  return source.slice(offset, stop);
}

test("late native status success cannot replace a newer stopped observation", async () => {
  const pending = [], statuses = [], checks = [];
  const api = await load("src/desktop/main.tsx", {
    useCallback: (fn) => fn, isTauri: true, locale: "en",
    agentStatusGeneration: { current: 0 },
    getAgentStatus: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    setAgentStatus: (status) => statuses.push(status),
    setLastStatusCheck: (value) => checks.push(value),
    friendlyAgentError: (value) => value, errMsg: String,
  }, (source) => `${slice(source, "const refreshStatus = useCallback", "const refreshLocalPrinters = useCallback")}\nexport { refreshStatus };`);
  const older = api.refreshStatus(), newer = api.refreshStatus();
  pending[1].resolve({ running: false, note_code: "not_running" });
  await newer;
  pending[0].resolve({ running: true, note_code: "service_running" });
  await older;
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].running, false);
  assert.equal(checks.length, 1);
});

test("late native status failure cannot replace newer verified service evidence", async () => {
  const pending = [], statuses = [];
  const api = await load("src/desktop/main.tsx", {
    useCallback: (fn) => fn, isTauri: true, locale: "en",
    agentStatusGeneration: { current: 0 },
    getAgentStatus: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    setAgentStatus: (status) => statuses.push(status), setLastStatusCheck: () => {},
    friendlyAgentError: (value) => value, errMsg: String,
  }, (source) => `${slice(source, "const refreshStatus = useCallback", "const refreshLocalPrinters = useCallback")}\nexport { refreshStatus };`);
  const older = api.refreshStatus(), newer = api.refreshStatus();
  pending[1].resolve({ running: true, note_code: "service_running" });
  await newer;
  pending[0].reject(new Error("stale SCM failure"));
  await older;
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].note_code, "service_running");
});

test("current native status failure remains visible after a successful observation", async () => {
  const pending = [], statuses = [];
  const api = await load("src/desktop/main.tsx", {
    useCallback: (fn) => fn, isTauri: true, locale: "en",
    agentStatusGeneration: { current: 0 },
    getAgentStatus: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    setAgentStatus: (status) => statuses.push(status), setLastStatusCheck: () => {},
    friendlyAgentError: () => "Current status unavailable", errMsg: String,
  }, (source) => `${slice(source, "const refreshStatus = useCallback", "const refreshLocalPrinters = useCallback")}\nexport { refreshStatus };`);
  const older = api.refreshStatus();
  pending[0].resolve({ running: true, note_code: "service_running" });
  await older;
  const current = api.refreshStatus();
  pending[1].reject(new Error("current SCM failure"));
  await current;
  assert.equal(statuses.at(-1).error, "Current status unavailable");
});

async function presentation() {
  return load("src/desktop/lib/printers.ts", {}, (source, path) => path.endsWith("/printers.ts")
    ? `import { DEFAULT_LOCALE } from "../../i18n/config";
       import { translate as tr } from "../../i18n/translate";
       ${slice(source, "export function friendlyGatewayError", "export function friendlyPrinterError")}`
    : source);
}

test("Gateway HTTP status survives machine messages in English and Arabic", async () => {
  const api = await presentation();
  const catalogs = await load("src/i18n/translate.ts");
  for (const locale of ["en", "ar"]) {
    for (const [status, key] of [[500, "serverError"], [503, "serverError"], [401, "unauthorized"], [403, "unauthorized"], [404, "notGateway"]]) {
      const error = Object.assign(new Error("INTERNAL_ERROR"), { status });
      assert.equal(api.friendlyGatewayError(error, locale), catalogs.translate(locale, `desktop.gateway.${key}`));
    }
    assert.equal(api.friendlyGatewayError(null, locale), catalogs.translate(locale, "desktop.gateway.failed"));
  }
});

test("Gateway native transport causes keep specific guidance", async () => {
  const api = await presentation();
  const catalogs = await load("src/i18n/translate.ts");
  for (const locale of ["en", "ar"]) {
    for (const [message, key] of [
      ["Gateway probe failed: connect: error sending request: dns error: failed to lookup address", "dns"],
      ["Gateway probe failed: connect: invalid peer certificate: UnknownIssuer", "tls"],
      ["Gateway probe failed: timeout: operation timed out", "timeout"],
    ]) {
      assert.equal(api.friendlyGatewayError(new Error(message), locale), catalogs.translate(locale, `desktop.gateway.${key}`));
    }
  }
});

test("candidate probe preserves HTTP failure and still rejects non-Gateway responses", async () => {
  const ipcSource = await readFile("src/desktop/lib/ipc.ts", "utf8");
  let response = { status: 500, body: '{"error":"INTERNAL_ERROR"}' };
  const requests = [];
  const api = await load("src/desktop/lib/ipc.ts", {
    isTauri: true,
    normalizeGatewayUrl: (value) => value,
    invoke: async (command, args) => { requests.push({ command, args }); return response; },
  }, () => `${slice(ipcSource, "function gatewayErrorMessage", "async function gatewayConsoleRequest")}
           ${slice(ipcSource, "export async function probeGatewayHealth", "export async function fetchGatewayHealth")}`);
  await assert.rejects(api.probeGatewayHealth("https://print.yaseir.cloud"), (error) => error.status === 500 && error.message === "Gateway probe failed (500)");
  response = { status: 200, body: '{"ok":true}' };
  await assert.rejects(api.probeGatewayHealth("https://print.yaseir.cloud"), /unexpected service response/);
  response = { status: 404, body: "Not found" };
  await assert.rejects(api.probeGatewayHealth("https://print.yaseir.cloud"), (error) => error.status === 404);
  response = { status: 200, body: '{"ok":true,"service":"yaseir-print-gateway"}' };
  assert.equal((await api.probeGatewayHealth("https://print.yaseir.cloud")).ok, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.command === "probe_gateway_health" && Object.keys(request.args).join() === "url"));
});

test("Gateway HTTP adapter refuses remote diagnostics and invalid usage numbers", async () => {
  const ipcSource = await readFile("src/desktop/lib/ipc.ts", "utf8");
  const api = await load("src/desktop/lib/ipc.ts", {}, () =>
    `${slice(ipcSource, "function gatewayErrorMessage", "async function gatewayConsoleRequest")}\nexport { gatewayHttpError };`);

  const remoteText = "SQL password=MY_PRIVATE_SECRET from C:/agent-config.json";
  const malformed = api.gatewayHttpError(429, JSON.stringify({
    error: remoteText, code: "PRINT_QUOTA_EXCEEDED",
    entitlement: "max_prints_per_period", limit: -14, used: 1e309,
    upgradeRequired: true,
  }), "Print submission failed (429)");
  assert.equal(malformed.message, "Print submission failed (429)");
  assert.equal(malformed.code, "PRINT_QUOTA_EXCEEDED");
  assert.equal(malformed.entitlement, "max_prints_per_period");
  assert.equal(malformed.upgradeRequired, true);
  assert.equal(malformed.limit, undefined);
  assert.equal(malformed.used, undefined);
  assert.doesNotMatch(malformed.message, /MY_PRIVATE_SECRET|SQL|agent-config/);

  const valid = api.gatewayHttpError(429, '{"limit":15,"used":7,"error":"PRIVATE_REMOTE_TEXT"}', "Print admission failed");
  assert.equal(valid.message, "Print admission failed");
  assert.equal(valid.limit, 15);
  assert.equal(valid.used, 7);
  const plain = api.gatewayHttpError(503, "password=REMOTE_TOKEN", "Gateway temporarily unavailable");
  assert.equal(plain.message, "Gateway temporarily unavailable");
  assert.equal(plain.status, 503);
});

test("failed candidate check keeps configuration and presents HTTP guidance once", async () => {
  const { friendlyGatewayError } = await presentation();
  const { translate } = await load("src/i18n/translate.ts");
  const changes = [], drafts = [], messages = [];
  const api = await load("src/desktop/main.tsx", {
    useCallback: (fn) => fn, gatewayUrl: "https://print.yaseir.cloud", locale: "ar",
    t: (key) => translate("ar", key), normalizeGatewayUrl: (value) => value,
    configurationFlight: { current: false }, savedOriginRef: { current: "https://existing.example" },
    setGatewayChecking: () => {}, setGatewayDraftError: (value) => drafts.push(value),
    probeGatewayHealth: async () => { throw Object.assign(new Error("INTERNAL_ERROR"), { status: 500 }); },
    setGatewayUrl: async (value) => changes.push(value),
    setMsg: (value) => messages.push(value), friendlyGatewayError,
    observeGatewayFailure: () => false,
    observeGatewaySuccess: () => true,
    savedOriginMatches: () => false,
    invalidateGatewayInventory: () => assert.fail("a failed candidate probe must preserve the saved Gateway inventory"),
    errMsg: (error) => error instanceof Error ? error.message : String(error),
  }, (source) => `${slice(source, "const checkHealth = useCallback", "const handleDiscover = useCallback")}\nexport { checkHealth };`);
  await api.checkHealth();
  assert.equal(changes.length, 0);
  assert.equal(drafts.at(-1), translate("ar", "desktop.gateway.serverError"));
  assert.equal(messages.at(-1).text, drafts.at(-1));
  const settings = await readFile("src/desktop/pages/Settings.tsx", "utf8");
  assert.doesNotMatch(settings, /friendlyGatewayError\(/);
  const shell = await readFile("src/desktop/main.tsx", "utf8");
  assert.doesNotMatch(shell, /AgentsPage|page === "agents"/);
});

test("native probe records bounded diagnostics without response bodies or credentials", async () => {
  const source = await readFile("src-tauri/src/commands.rs", "utf8");
  const probe = slice(source, "pub async fn probe_gateway_health", "pub struct AgentGatewayRequestArgs");
  assert.match(probe, /Gateway probe started/);
  assert.match(probe, /status=\{status\} confirmed=\{confirmed\}/);
  assert.match(probe, /logging::warn/);
  assert.match(probe, /logging::error/);
  assert.match(probe, /std::error::Error::source/);
  assert.match(probe, /error\.without_url\(\)/);
  assert.match(probe, /take\(2048\)/);
  assert.doesNotMatch(probe, /logging::\w+\([^;]*(?:\{body\}|bearer_auth|cookie)/);
});


test("saved Gateway connectivity auto-refreshes with the public identity probe and transient-failure hysteresis", async () => {
  const source = await readFile("src/desktop/main.tsx", "utf8");
  const probe = slice(source, "const probeGateway = useCallback", "const checkHealth = useCallback");
  assert.match(probe, /await probeGatewayHealth\(targetUrl\)/);
  assert.doesNotMatch(probe, /fetchGatewayHealth/);
  assert.match(probe, /observeGatewayFailure/);
  assert.match(source, /noteGatewayConnectivityFailure/);
  assert.match(source, /noteGatewayConnectivitySuccess/);
  assert.match(source, /window\.setInterval\(runProbe, GATEWAY_AUTO_PROBE_INTERVAL_MS\)/);
  assert.match(source, /window\.addEventListener\("online", runProbe\)/);
  assert.match(source, /window\.addEventListener\("focus", runProbe\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisible\)/);
  assert.doesNotMatch(source, /target !== savedGatewayUrl/);
  assert.doesNotMatch(source, /healthFresh/);
});

test("legacy trailing-slash Gateway values are canonicalized before connectivity comparison", async () => {
  const source = await readFile("src/desktop/main.tsx", "utf8");
  assert.match(source, /canonical = normalizeGatewayUrl\(v\)/);
  const probe = slice(source, "const probeGateway = useCallback", "const checkHealth = useCallback");
  assert.match(probe, /normalizeGatewayUrl\(savedOriginRef\.current\) === targetUrl/);
});


test("desktop reuses one native HTTP client for probe and isolates paired Agent requests", async () => {
  const source = await readFile("src-tauri/src/commands.rs", "utf8");
  assert.match(source, /static GATEWAY_HTTP_CLIENT: OnceLock<reqwest::Client>/);
  assert.match(source, /fn gateway_http_client\(\)/);
  assert.equal((source.match(/reqwest::Client::builder\(\)/g) ?? []).length, 1);
  const probe = slice(source, "pub async fn probe_gateway_health", "fn gateway_request_id");
  assert.match(probe, /gateway_http_client\(\)/);
  assert.doesNotMatch(source, /pub async fn gateway_request\(/);
  assert.match(source, /pub async fn gateway_agent_request/);
  const gateway=await readFile("agent/cmd/cli/gateway.go","utf8");
  assert.match(gateway, /req.Header.Set\("Authorization", "Bearer "/);
});
