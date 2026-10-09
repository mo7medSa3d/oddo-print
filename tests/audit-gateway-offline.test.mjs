import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve, dirname } from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";

// Strip types from actual source, using only Node's bundled parser. Framework
// typechecking still needs the project's dependencies and is a separate check.
async function loadModule(file, globals = {}, select = (source) => source) {
  const context = vm.createContext({ console, Date, Set, ...globals });
  const modules = new Map();
  async function get(path) {
    if (modules.has(path)) return modules.get(path);
    if (path.startsWith("node:")) {
      const builtin = await import(path);
      const loadedModule = new vm.SyntheticModule(Object.keys(builtin), function () {
        for (const [key, value] of Object.entries(builtin)) this.setExport(key, value);
      }, { context });
      modules.set(path, loadedModule);
      return loadedModule;
    }
    const source = select(await readFile(path, "utf8"), path);
    const loadedModule = new vm.SourceTextModule(stripTypeScriptTypes(source), { context, identifier: path });
    modules.set(path, loadedModule);
    await loadedModule.link((name) => get(name.startsWith("node:") ? name : resolve(dirname(path), `${name}.ts`)));
    return loadedModule;
  }
  const loadedModule = await get(resolve(file));
  await loadedModule.evaluate();
  return loadedModule.namespace;
}

test("error keys reject prototype properties and keep valid translations", async () => {
  const api = await loadModule("src/lib/api-error-keys.ts");
  for (const code of ["constructor", "toString", "__proto__"]) assert.equal(api.codeMessageKey(code), null);
  assert.equal(api.codeMessageKey("PRINTER_NOT_FOUND"), "errors.printerNotFound");
  assert.equal(api.apiMessageKey("constructor", 503), "errors.serviceUnavailable");
});

test("public cache policy preserves revalidation and has no fake tenant header", async () => {
  const api = await loadModule("src/lib/cache.ts");
  assert.equal(api.PUBLIC_VARY_CACHE_CONTROL, "public, max-age=30, stale-while-revalidate=300, s-maxage=30");
  assert.deepEqual(Object.keys(api), ["PUBLIC_VARY_CACHE_CONTROL"]);
});

test("non-JSX TypeScript source parses with Node's existing bundled parser", async () => {
  async function files(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...await files(path));
      else if (/\.(ts|mts)$/.test(entry.name)) out.push(path);
    }
    return out;
  }
  const paths = [resolve("server.ts"), ...await files("src"), ...await files("scripts"), ...await files("tests")];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "transform", sourceMap: false });
    new vm.SourceTextModule(stripped, { identifier: path });
  }
  console.log(`Parsed ${paths.length} non-JSX TypeScript files; types and TSX still require the normal toolchain.`);
});

test("physical shared v4 printers stay selectable while software writers are rejected", async () => {
  const api = await loadModule("src/lib/printer-virtual.ts");
  assert.equal(api.isVirtualPrinterRecord({ name: "Office", connectionType: "spooler", protocol: "spooler", driverName: "Microsoft enhanced point and print compatibility driver", port: "\\\\server\\queue" }), false);
  assert.equal(api.isVirtualPrinterRecord({ name: "Office", driverName: "Microsoft Print to PDF", port: "PORTPROMPT:" }), true);
});

test("actual Stripe normalization accepts item periods and bounds corrupt values", async () => {
  const api = await loadModule("src/lib/stripe.ts", {}, (source) => {
    const index = source.indexOf("export function stripeSubscriptionPeriod(");
    assert.ok(index >= 0);
    return source.slice(index);
  });
  const start = 1_700_000_000, end = start + 2_592_000;
  const modern = api.stripeSubscriptionPeriod({ items: { data: [{ current_period_start: start, current_period_end: end }] } });
  const legacy = api.stripeSubscriptionPeriod({ current_period_start: start, current_period_end: end });
  assert.equal(modern.start.getTime(), legacy.start.getTime());
  assert.equal(modern.end.getTime(), end * 1000);
  for (const value of [NaN, -1, "1700000000", 8_640_000_000_001, 1.5]) {
    const result = api.stripeSubscriptionPeriod({ current_period_start: value, current_period_end: value });
    assert.equal(result.start, null);
    assert.equal(result.end, null);
  }
});

test("existing Gateway i18n checker passes against both real catalogs", async () => {
  const logs = [];
  await loadModule("scripts/check-i18n.ts", {
    console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    process: { exit: (code) => { throw new Error(`i18n checker exited ${code}: ${logs.join("\n")}`); } },
  });
  assert.ok(logs.some((line) => line.includes("all catalogs are complete and consistent")), logs.join("\n"));
  console.log(logs.join("\n"));
});

test("desktop discovery preserves a failed Gateway refresh and uses translated outcome", async () => {
  const source = await readFile("src/desktop/main.tsx", "utf8");
  const start = source.indexOf("  const handleDiscover = useCallback(");
  const end = source.indexOf("  const enableVirtualPrinterTest = useCallback(", start);
  assert.ok(start >= 0 && end > start);
  const errors = [], messages = [];
  const refresh = async () => { errors.push("Gateway unavailable"); return false; };
  const api = await loadModule("src/desktop/main.tsx", {
    useCallback: (fn) => fn, isTauri: true, locale: "ar",
    setPrintersLoading: () => {}, setPrintersError: (error) => errors.push(error),
    setDiscoveryWarning: () => {}, setDiscoveredPrinters: () => {}, setDiscoveredVirtualPrinters: () => {}, refreshPrinters: refresh,
    discoverPrinters: async () => ({ printers: [{ id: "physical" }], errors: [] }),
    isProductionPrinter: () => true, isVirtualPrinter: () => false,
    t: (key, values) => `${key}:${values?.count ?? ""}`,
    setMsg: (message) => messages.push(message),
    friendlyPrinterError: (text) => text, errMsg: String,
  }, () => `${source.slice(start, end)}\nexport { handleDiscover };`);
  await api.handleDiscover();
  assert.equal(errors.at(-1), "Gateway unavailable");
  assert.equal(messages[0].type, "info");
  assert.equal(messages[0].text, "desktop.app.discoveryFound:1");
});

test("failed WebSocket handshake releases capacity and pending registration", async () => {
  const source = await readFile("src/server/ws.ts", "utf8");
  const start = source.indexOf("export function attachAgentWSS(");
  assert.ok(start >= 0);
  let reservations = 0, pending = 0, failures = 0;
  class WSS extends EventEmitter {
    clients = new Set();
    handleUpgrade() { throw new Error("invalid handshake"); }
    close() { this.emit("close"); }
  }
  const api = await loadModule("src/server/ws.ts", {
    setInterval, clearInterval, WebSocketServer: WSS,
    MAX_WS_MESSAGE_BYTES: 1024,
    trustProxyEnabled: () => false, isAllowedWebSocketOrigin: () => true,
    websocketClientKey: () => "client",
    reserveWsUpgradeAttempt: async () => ({ allowed: true }),
    validateAgent: async () => ({ id: "agent", tenantId: "tenant", lifecycleRevision: 0 }),
    recordWsUpgradeSuccess: async () => {},
    reserveAgentSocketSlot: () => { reservations++; return true; },
    releaseAgentSocketSlot: () => { reservations--; },
    markAgentSocketRegistrationPending: () => { pending++; },
    finishAgentSocketRegistrationPending: (_agent, ready) => { assert.equal(ready, false); pending--; },
    logUpgradeError: () => {}, logDebug: () => {},
    writeWsHttpError: () => { failures++; },
  }, () => source.slice(start));
  const server = new EventEmitter(), socket = new EventEmitter();
  const wss = api.attachAgentWSS(server, { enableJobNotifications: false });
  try {
    const upgrade = server.listeners("upgrade")[0];
    await upgrade({ url: "/api/agent/ws", headers: { authorization: "Bearer valid" } }, socket, Buffer.alloc(0));
    assert.equal(reservations, 0);
    assert.equal(pending, 0);
    assert.equal(failures, 1);
    socket.emit("close");
    assert.equal(reservations, 0);
    assert.equal(pending, 0);
  } finally {
    wss.close();
  }
});


test("desktop discovery surfaces persistence warnings and keeps local printers visible", async () => {
  const source = await readFile("src/desktop/main.tsx", "utf8");
  const start = source.indexOf("  const handleDiscover = useCallback(");
  const end = source.indexOf("  const enableVirtualPrinterTest = useCallback(", start);
  const warnings = [], discovered = [], messages = [];
  const api = await loadModule("src/desktop/main.tsx", {
    useCallback: (fn) => fn, isTauri: true, locale: "en",
    setPrintersLoading: () => {}, setPrintersError: () => {},
    setDiscoveryWarning: (value) => warnings.push(value),
    setDiscoveredPrinters: (value) => discovered.push(value),
    setDiscoveredVirtualPrinters: () => {},
    refreshPrinters: async () => true,
    discoverPrinters: async () => ({ printers: [{ id: "local-1", connectionType: "spooler", protocol: "spooler" }], errors: ["Failed to persist discovery: access denied"] }),
    isProductionPrinter: () => true, isVirtualPrinter: () => false,
    t: (key, values) => `${key}:${values?.count ?? ""}`,
    setMsg: (message) => messages.push(message),
    friendlyPrinterError: (text) => text, errMsg: String,
  }, () => `${source.slice(start, end)}\nexport { handleDiscover };`);
  await api.handleDiscover();
  assert.equal(discovered.at(-1).length, 1);
  assert.equal(warnings.at(-1), "desktop.app.discoveryWarningsSummary:1");
  assert.equal(messages.at(-1).text, "desktop.app.discoveryPartial:1");
  assert.equal(messages.at(-1).type, "info");

  const page = await readFile("src/desktop/pages/Printers.tsx", "utf8");
  assert.match(page, /pendingLocal/);
  assert.match(page, /waitingForSync/);
  assert.match(page, /s\.discoveredPrinters/);
});

test("printer evidence stays independent from agent reachability in shared UI vocabulary", async () => {
  const api = await loadModule("src/shared/job-vocabulary.ts");
  const nowMs = Date.parse("2026-10-05T10:00:00Z");
  const freshPrinter = { lifecycle: "active", status: "online", lastSeenAt: new Date(nowMs - 30_000).toISOString() };
  const staleAgent = { lifecycle: "active", status: "online", lastSeenAt: new Date(nowMs - 10 * 60_000).toISOString() };
  assert.equal(api.effectivePrinterStatus(freshPrinter, staleAgent, nowMs), "online");
  assert.equal(api.effectivePrinterStatus({ ...freshPrinter, status: "busy" }, staleAgent, nowMs), "busy");
  assert.equal(api.effectivePrinterStatus({ ...freshPrinter, status: "error" }, staleAgent, nowMs), "error");
  assert.equal(api.effectivePrinterStatus({ ...freshPrinter, lastSeenAt: new Date(nowMs - 10 * 60_000).toISOString() }, staleAgent, nowMs), "unknown");
});

test("Test Print fail-fast response states that no queued job exists", async () => {
  const source = await readFile("src/app/api/printers/[id]/test-print/route.ts", "utf8");
  assert.match(source, /Test print was not queued/);
  assert.doesNotMatch(source, /test print will be queued until the agent reconnects/i);
  assert.ok(source.indexOf("if (!availability.available)") < source.indexOf("createPrintJobForPrinter("));
});

test("printer diagnostics keep Agent availability independent from lifecycle and network config", async () => {
  const source = await readFile("src/app/api/printers/[id]/test-connection/route.ts", "utf8");
  const agentLookup = source.indexOf("const agent = await db.query.agents.findFirst");
  const agentState = source.indexOf("const agentState = {");
  const lifecycle = source.indexOf('if (printer.lifecycle !== "active")');
  const networkConfig = source.indexOf('if (printer.connectionType === "network"');
  const unavailable = source.indexOf("if (!availability.available)", networkConfig);
  assert.ok(agentLookup >= 0 && agentState > agentLookup && lifecycle > agentState);
  assert.match(source.slice(lifecycle, networkConfig), /\.\.\.agentState/);
  assert.match(source.slice(networkConfig, unavailable), /\.\.\.agentState/);
  assert.match(source, /lastHeartbeatAt: agent\.lastSeenAt/);
  assert.match(source, /agentOnline: availability\.available/);
});

test("Odoo spooler and IPP diagnostics preserve the selected binding document type", async () => {
  const source = await readFile("odoo_addons/print_gateway/models/print_router.py", "utf8");
  const spooler = source.slice(source.indexOf("def _route_spooler_test_page"), source.indexOf("def _route_ipp_test_page"));
  const ipp = source.slice(source.indexOf("def _route_ipp_test_page"), source.indexOf("def _generate_test_pdf"));
  for (const block of [spooler, ipp]) {
    assert.match(block, /document_type=binding\.document_type/);
    assert.match(block, /document_type=binding\.document_type/);
    assert.doesNotMatch(block, /job_document_type="test_page"/);
  }
  assert.match(source, /"document_type": route\["document_type"\]/);
});

test("spooler document baseline and explicit byte passthrough stay separate", async () => {
  const api = await loadModule("src/lib/printer-capability.ts", {}, (source) =>
    source.replace(
      'import payloadContract from "../../contracts/print-payload-contract.json";',
      'const payloadContract = { rawProtocols: ["raw", "escpos", "zpl", "tspl"] };',
    )
  );
  const spooler = { protocol: "spooler", connectionType: "spooler" };
  assert.equal(api.validatePayloadForPrinter({ type: "pdf" }, spooler).ok, true);
  assert.equal(api.validatePayloadForPrinter({ type: "image" }, spooler).ok, true);
  const rejectedEscpos = api.validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, spooler);
  assert.equal(rejectedEscpos.ok, false);
  assert.match(rejectedEscpos.reason, /has not been declared as ESC\/POS-capable/);

  const escpos = { ...spooler, capabilities: { supported_protocols: ["escpos"] } };
  assert.equal(api.validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, escpos).ok, true);
  assert.equal(api.validatePayloadForPrinter({ type: "raw", protocol: "raw" }, escpos).ok, false);
  assert.equal(api.validatePayloadForPrinter({ type: "pdf" }, escpos).ok, true);
  assert.equal(api.validatePayloadForPrinter({ type: "image" }, escpos).ok, true);

  const raw = { ...spooler, capabilities: { supported_protocols: ["raw"] } };
  assert.equal(api.validatePayloadForPrinter({ type: "raw", protocol: "raw" }, raw).ok, true);
  assert.equal(api.validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, raw).ok, false);
});

test("printer transport changes scrub inherited spooler passthrough without accepting invalid new passthrough", async () => {
  const source = await readFile("src/app/api/printers/[id]/route.ts", "utf8");
  assert.match(source, /parsed\.data\.config\?\.passthrough_protocols !== undefined && connectionType !== "spooler"/);
  assert.match(source, /const scrubInheritedPassthrough = connectionType !== "spooler"/);
  assert.match(source, /if \(scrubInheritedPassthrough\) delete cfg\.passthrough_protocols/);
  assert.match(source, /parsed\.data\.config !== undefined \|\| scrubInheritedPassthrough/);
});

test("Odoo explicit raw binding validates the caller destination rather than itself", async () => {
  const source = await readFile("odoo_addons/print_gateway/models/print_router.py", "utf8");
  const block = source.slice(source.indexOf("def route_raw_command"), source.indexOf("def route_test_page"));
  assert.match(block, /explicit_destination=destination/);
  assert.doesNotMatch(block, /explicit_destination=binding\.destination_ref or destination/);
  assert.match(source, /document_type=binding\.document_type/);
});
