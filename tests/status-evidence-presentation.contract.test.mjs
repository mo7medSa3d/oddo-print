import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("effective Agent presentation preserves stale and missing evidence as unknown", () => {
  const helper = read("src/lib/agent-availability.ts");
  const agentsRoute = read("src/app/api/agents/route.ts");
  const printersRoute = read("src/app/api/printers/route.ts");
  const agentDetailRoute = read("src/app/api/agents/[id]/route.ts");
  const printerDetailRoute = read("src/app/api/printers/[id]/route.ts");
  const dashboardState = read("src/lib/dashboard-state.ts");
  const odooAgents = read("src/app/api/odoo/agents/route.ts");

  assert.match(helper, /export function getEffectiveAgentStatus/);
  assert.match(helper, /freshness !== "fresh"\) return "unknown"/);
  assert.match(helper, /raw === "online" \|\| raw === "offline"/);

  for (const source of [agentsRoute, dashboardState, odooAgents]) {
    assert.match(source, /getEffectiveAgentStatus\(agent, now\)/);
    assert.doesNotMatch(source, /isAgentAvailableForJob\(agent, now\) \? "online" : "offline"/);
  }
  assert.match(agentsRoute, /reportedStatus: agent\.status/);
  assert.match(agentsRoute, /freshness: getAgentHeartbeatFreshness/);
  assert.match(printersRoute, /agentStatus: agent \? getEffectiveAgentStatus\(agent, now\) : "unknown"/);
  assert.match(agentDetailRoute, /status: getEffectiveAgentStatus\(agent, now\)/);
  assert.match(agentDetailRoute, /reportedStatus: agent\.status/);
  assert.doesNotMatch(agentDetailRoute, /isAgentAvailableForJob\(agent, now\) \? "online" : "offline"/);
  assert.match(printerDetailRoute, /status: getEffectivePrinterStatus\(row, ownerAgent \?\? null, now\)/);
  assert.match(printerDetailRoute, /agentStatus: ownerAgent \? getEffectiveAgentStatus\(ownerAgent, now\) : "unknown"/);
});

test("stale printer evidence is never promoted back to its last reported status", () => {
  const dashboard = read("src/app/dashboard/dashboard-client.tsx");
  const desktop = read("src/desktop/lib/printers.ts");
  const odooAgentField = read("odoo_addons/print_gateway/static/src/components/runtime_agent_field.js");
  const odooPrinterField = read("odoo_addons/print_gateway/static/src/components/runtime_printer_field.js");

  assert.doesNotMatch(dashboard, /freshness === "stale" \? \(printer\.reportedStatus/);
  assert.match(dashboard, /const displayStatus = effStatus;/g);

  const desktopDisplay = desktop.slice(desktop.indexOf("export function printerDisplayStatus"), desktop.indexOf("export function isVirtualPrinter"));
  assert.match(desktopDisplay, /return p\.status \|\| "unknown"/);
  assert.doesNotMatch(desktopDisplay, /return[^\n]*reportedStatus/);

  const agentStatusLabel = odooAgentField.slice(odooAgentField.indexOf("statusLabel(agent)"), odooAgentField.indexOf("get emptyMessage"));
  const printerStatusStart = odooPrinterField.indexOf("statusLabel(printer)");
  const printerStatusLabel = odooPrinterField.slice(printerStatusStart, odooPrinterField.indexOf("\n    deviceClassLabel", printerStatusStart));
  assert.match(agentStatusLabel, /const raw = agent\?\.status \|\| "unknown"/);
  assert.doesNotMatch(agentStatusLabel, /reportedStatus/);
  assert.match(printerStatusLabel, /const raw = printer\?\.status \|\| "unknown"/);
  assert.doesNotMatch(printerStatusLabel, /reportedStatus/);
});

test("Odoo sanitization and docs fail missing current status to unknown", () => {
  const controller = read("odoo_addons/print_gateway/controllers/runtime_printers.py");
  const api = read("API.md");
  const odooDocs = read("ODOO_INTEGRATION.md");
  assert.match(controller, /agent\.get\('status'\).*else 'unknown'/);
  assert.match(api, /stale or missing Agent\/printer observations resolve to `unknown`/);
  assert.match(api, /`reportedStatus` retains the last raw device\/Agent report for diagnostics/);
  assert.match(odooDocs, /`reportedStatus` is retained only for diagnostics\/history/);
});
