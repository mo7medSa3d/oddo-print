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
  const end = source.indexOf("  const updatePrinterLifecycle", start);
  assert.ok(start >= 0 && end > start);
  const errors = [], messages = [];
  const refresh = async () => { errors.push("Gateway unavailable"); return false; };
  const api = await loadModule("src/desktop/main.tsx", {
    useCallback: (fn) => fn, isTauri: true, locale: "ar",
    setPrintersLoading: () => {}, setPrintersError: (error) => errors.push(error),
    setDiscoveredPrinters: () => {}, refreshPrinters: refresh,
    discoverPrinters: async () => ({ printers: [{ id: "physical" }], errors: [] }),
    isProductionPrinter: () => true,
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
