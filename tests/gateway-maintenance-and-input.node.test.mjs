import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const server = readFileSync("server.ts", "utf8");
const maintenance = server.slice(server.indexOf("function maintenanceTask("), server.indexOf("function shutdown("));

test("maintenance ticks cannot overlap and recover after success, failure or synchronous throw", async () => {
  for (const failure of [false, true, "synchronous"]) {
    let calls = 0;
    let settle;
    const errors = [];
    const context = vm.createContext({ shuttingDown: false, logError: (...args) => errors.push(args) });
    vm.runInContext(stripTypeScriptTypes(maintenance) + "\nglobalThis.makeTask = maintenanceTask;", context);
    const tick = context.makeTask(() => {
      calls++;
      if (failure === "synchronous") throw new Error("sync failure");
      return new Promise((resolve, reject) => { settle = failure ? reject : resolve; });
    }, "maintenance.failed");
    tick();
    tick();
    await Promise.resolve();
    assert.equal(calls, 1);
    if (settle) settle(failure ? new Error("async failure") : undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, failure ? 1 : 0);
    tick();
    await Promise.resolve();
    assert.equal(calls, 2);
    if (settle) settle();
    await new Promise(resolve => setImmediate(resolve));
    context.shuttingDown = true;
    tick();
    await Promise.resolve();
    assert.equal(calls, 2);
  }
});

test("malformed dashboard action inputs are explicit400 failures before any query", async () => {
  const source = readFileSync("src/app/actions.ts", "utf8");
  class ActionError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
  for (const [name, end, inputs] of [
    ["getDashboardState", "const DASHBOARD_JOBS_MAX_OFFSET", [null, [], 42, { printerSearch: 42 }, { printerStatus: {} }]],
    ["getDashboardJobs", "async function dashboardResult", [null, [], "bad", { search: [] }, { status: 42 }]],
  ]) {
    const body = source.slice(source.indexOf(`export async function ${name}(`), source.indexOf(end));
    const context = vm.createContext({
      ActionError, getServerLocale: async () => "en", makeT: () => key => key,
      requireManager: async () => ({ tenantId: "tenant-a" }), requireManagerPermission() {},
    });
    const loaded = new vm.SourceTextModule(stripTypeScriptTypes(body), { context });
    await loaded.link(() => { throw new Error("unexpected dependency"); });
    await loaded.evaluate();
    for (const input of inputs) {
      await assert.rejects(loaded.namespace[name](input), error => error.status === 400 && error.code === "INVALID_REQUEST");
    }
  }
});

test("housekeeping waits for every cleanup even when one fails before accepting a new tick", async () => {
  let settle;
  let calls = 0;
  const context = vm.createContext({
    shuttingDown: false, logError() {},
    cleanupAuthRateLimits: async () => { calls++; throw new Error("outage"); },
    cleanupExpiredManagerSessions: () => new Promise(resolve => { settle = resolve; }),
    cleanupExpiredPlatformSessions: async () => {}, cleanupExpiredRefreshTokens: async () => {},
  });
  const declaration = server.slice(server.indexOf("  const housekeeping ="), server.indexOf("  housekeeping();"));
  vm.runInContext(stripTypeScriptTypes(maintenance + declaration) + "\nglobalThis.tick = housekeeping;", context);
  context.tick();
  await new Promise(resolve => setImmediate(resolve));
  context.tick();
  assert.equal(calls, 1);
  settle();
  await new Promise(resolve => setImmediate(resolve));
  context.tick();
  await Promise.resolve();
  assert.equal(calls, 2);
  settle();
  await new Promise(resolve => setImmediate(resolve));
});

test("dashboard rate denominator counts each terminal job once", () => {
  const source = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
  const start = source.indexOf("  const kpis = useMemo(() => {");
  const body = source.slice(start + "  const kpis = useMemo(() => {".length, source.indexOf("  }, [fleet, kpiJobs]);", start));
  const result = vm.runInNewContext(stripTypeScriptTypes("(() => {" + body + "})()"), {
    fleet: { totalAgents: 1, onlineAgents: 1, totalPrinters: 1, onlinePrinters: 1 },
    kpiJobs: [{ status: "success" }, { status: "failed" }, { status: "expired", error: "unknown" }, { status: "claimed" }],
    deriveOutcome: (status, error) => status === "success" || error === "unknown" ? "unknown" : "not_printed",
  });
  assert.equal(result.resolvedJobs, 3);
  assert.equal(result.successRate, 33);
});

test("logout requires both revocations and exposes failure without a rejected UI handler", async () => {
  const source = readFileSync("src/components/AppShell.tsx", "utf8");
  const body = source.slice(source.indexOf("  async function handleLogout()"), source.indexOf("  // Platform control plane"));
  for (const mode of ["offline", "503", "ok"]) {
    const routes = [], calls = [], failures = [];
    const context = vm.createContext({
      logoutFlight: { current: false }, setLoggingOut() {}, setLogoutFailed: failed => failures.push(failed),
      fetchWithTimeout: async url => { calls.push(url); if (mode === "offline") throw new TypeError("offline"); return { ok: mode === "ok" }; },
      router: { replace: route => routes.push(route), refresh() {} },
    });
    vm.runInContext(stripTypeScriptTypes(body) + "\nglobalThis.logout = handleLogout;", context);
    const pending = context.logout();
    await context.logout();
    await pending;
    assert.deepEqual(calls, ["/api/auth/manager/logout", "/api/auth/logout"]);
    assert.deepEqual(routes, mode === "ok" ? ["/"] : []);
    assert.deepEqual(failures, mode === "ok" ? [false] : [false, true]);
  }
});

test("a stale health response body cannot overwrite a newer sample or settle its loading state", async () => {
  const source = readFileSync("src/app/system-health/system-health-client.tsx", "utf8");
  const start = source.indexOf("useCallback(async (mode:") + "useCallback(".length;
  const body = source.slice(start, source.indexOf(", [t]);", start));
  const samples = [], loading = [];
  let resolveOld;
  const oldBody = new Promise(resolve => { resolveOld = resolve; });
  let calls = 0;
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout, console,
    request: { current: null }, t: key => key, statusMessageKey: () => undefined,
    setHealth: value => samples.push(value), setError() {},
    setLoading: value => loading.push(value), setRefreshing() {},
    fetchWithTimeout: async () => ({ ok: true, json: () => ++calls === 1 ? oldBody : Promise.resolve({ sample: "new" }) }),
  });
  vm.runInContext("globalThis.load = " + stripTypeScriptTypes(body), context);
  const old = context.load("initial");
  await Promise.resolve();
  await context.load("refresh");
  resolveOld({ sample: "old" });
  await old;
  assert.deepEqual(samples, [{ sample: "new" }]);
  assert.deepEqual(loading, [true, false]);
});
