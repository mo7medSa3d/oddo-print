import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function load(source, globals) {
  const context = vm.createContext({ ...globals });
  const loadedModule = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), { context });
  await loadedModule.link(() => { throw new Error("Unexpected dependency"); });
  await loadedModule.evaluate();
  return loadedModule.namespace;
}

async function lifecycleActions(agentLifecycle, failure) {
  const source = await readFile("src/app/actions.ts", "utf8");
  const action = source.slice(source.indexOf("export async function setPrinterLifecycle("), source.indexOf("export async function setAgentLifecycle("));
  const results = source.slice(source.indexOf("async function dashboardResult"));
  let writes = 0;
  const printer = { id: "printer", agent_id: "agent", lifecycle: "disabled", status: "offline" };
  const tx = {
    execute: async ({ text }) => {
      if (text.includes("SELECT agent_id")) return { rows: [{ agent_id: "agent" }] };
      if (text.includes("FROM agents")) return { rows: [{ lifecycle: agentLifecycle }] };
      if (text.includes("SELECT id, agent_id, lifecycle")) return { rows: [{ ...printer }] };
      return { rows: [] };
    },
    update: () => ({ set: values => ({ where: () => ({ returning: async () => {
      writes++;
      Object.assign(printer, values);
      return [{ id: printer.id, lifecycle: printer.lifecycle, desiredRevision: 1 }];
    } }) }) }),
  };
  const errors = await readFile("src/lib/action-error.ts", "utf8");
  const { ActionError } = await load(errors, {});
  const api = await load(action + "\n" + results, {
    ActionError,
    getServerLocale: async () => "en",
    makeT: () => (key, values) => values ? `${key}:${values.state}` : key,
    requireManager: async () => { if (failure) throw failure; return { tenantId: "tenant", userId: "user" }; },
    requireManagerPermission: () => {},
    db: { transaction: async fn => fn(tx) },
    sql: (strings, ...values) => ({ text: strings.join("?"), values }),
    printers: { id: "id", tenantId: "tenantId", lifecycle: "lifecycle", desiredRevision: 0 },
    eq: () => true, and: () => true,
    lifecycleLabel: (_t, state) => state,
    canTransitionLifecycle: (from, to) => from === "disabled" && to === "active",
    requireActiveTenantInTransaction: async () => {},
    writeAuditEvent: async () => {}, revalidatePath: () => {}, logError: () => {},
  });
  return { api, printer, writes: () => writes };
}

test("disabled owner rejects printer activation as a serializable conflict, not a thrown server error", async () => {
  const fixture = await lifecycleActions("disabled");
  const result = await fixture.api.setPrinterLifecycleResult("printer", "active");
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.error, "errors.printerOwnerLifecycle:disabled");
  assert.equal(fixture.writes(), 0);
  assert.equal(JSON.parse(JSON.stringify(result)).error, result.error);
});

test("offline active owner can save desired activation without making the printer online", async () => {
  const fixture = await lifecycleActions("active");
  const result = await fixture.api.setPrinterLifecycleResult("printer", "active");
  assert.equal(result.ok, true);
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.printer.lifecycle, "active");
  assert.equal(fixture.printer.status, "offline");
});

test("unexpected activation failures return a safe fallback without exposing server details", async () => {
  const fixture = await lifecycleActions("active", new Error("private database credentials"));
  const result = await fixture.api.setPrinterLifecycleResult("printer", "active");
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, null);
  assert.equal(result.code, "INTERNAL_ERROR");
  assert.equal(fixture.writes(), 0);
});

test("dashboard unwraps lifecycle conflicts as operator messages and redirects expired sessions", async () => {
  const source = await readFile("src/app/dashboard/dashboard-client.tsx", "utf8");
  const start = source.indexOf("  const dashboardRequest = ");
  const end = source.indexOf("  const getDashboardJobs = ", start);
  const redirects = [];
  const api = await load(source.slice(start, end) + "\nexport { dashboardRequest };", {
    React: { useCallback: fn => fn },
    ensureCustomerSession: async () => ({ authenticated: true }),
    router: { replace: path => redirects.push(path) },
    t: key => key, apiMessageKey: () => "errors.operationFailed",
  });
  await assert.rejects(api.dashboardRequest(async () => ({ ok: false, status: 409, code: "INTERNAL_ERROR", error: "Enable the owning Agent first" })), /Enable the owning Agent first/);
  await assert.rejects(api.dashboardRequest(async () => ({ ok: false, status: 401, code: "UNAUTHORIZED", error: "Session expired" })), /Session expired/);
  assert.equal(redirects[0], "/login?next=%2Fdashboard");
});
