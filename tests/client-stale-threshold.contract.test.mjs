import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (path) => fs.readFileSync(path, "utf8");

function staleThresholdModuleSource() {
  // stale-threshold.ts is deliberately dependency-free. Strip only the
  // function return/argument annotations it uses so Node's VM can execute the
  // exact module logic in a browser-like context without a TypeScript loader.
  return read("src/lib/stale-threshold.ts")
    .replace(/\(value: unknown\): number/g, "(value)")
    .replace(/\(\): number/g, "()");
}

async function loadStaleThreshold(contextValues = {}) {
  const context = vm.createContext(contextValues);
  const mod = new vm.SourceTextModule(staleThresholdModuleSource(), { context });
  await mod.link(() => {
    throw new Error("stale-threshold.ts must remain import-free for client bundles");
  });
  await mod.evaluate();
  return mod.namespace;
}

test("client bundle can resolve the default threshold without a Node process global", async () => {
  const mod = await loadStaleThreshold();
  assert.equal(mod.agentStaleThresholdSeconds(), 90);
});

test("server environment and propagated client values use the same bounded policy", async () => {
  const mod = await loadStaleThreshold({ process: { env: { STALE_AGENT_THRESHOLD_SECONDS: "120" } } });
  assert.equal(mod.agentStaleThresholdSeconds(), 120);
  assert.equal(mod.resolveAgentStaleThresholdSeconds(120), 120);
  assert.equal(mod.resolveAgentStaleThresholdSeconds(89), 90);
  assert.equal(mod.resolveAgentStaleThresholdSeconds(3601), 90);
});

test("Gateway response and web/Desktop consumers propagate the configured threshold", () => {
  const agentsRoute = read("src/app/api/agents/route.ts");
  const printersRoute = read("src/app/api/printers/route.ts");
  const dashboardState = read("src/lib/dashboard-state.ts");
  const desktopIpc = read("src/desktop/lib/ipc.ts");
  const desktopPrinters = read("src/desktop/lib/printers.ts");
  const addPrinter = read("src/desktop/components/AddPrinterDialog.tsx");
  const shared = read("src/shared/job-vocabulary.ts");

  assert.match(agentsRoute, /staleThresholdSeconds\s*=\s*agentStaleThresholdSeconds\(\)/);
  assert.match(agentsRoute, /staleThresholdSeconds,/);
  assert.match(printersRoute, /agentStaleThresholdSeconds:\s*agentFreshnessThresholdSeconds/);
  assert.match(dashboardState, /staleThresholdSeconds\s*=\s*agentStaleThresholdSeconds\(\)/);
  assert.match(desktopIpc, /agentStaleThresholdSeconds\?:\s*number\s*\|\s*null/);
  assert.match(desktopIpc, /staleThresholdSeconds\?:\s*number\s*\|\s*null/);
  assert.match(desktopPrinters, /staleThresholdSeconds:\s*printer\.agentStaleThresholdSeconds/);
  assert.match(addPrinter, /staleThresholdSeconds:\s*a\.staleThresholdSeconds/);
  assert.match(shared, /resolveAgentStaleThresholdSeconds\(agent\.staleThresholdSeconds\)/);
});
