import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("platform printer aggregates use printer evidence instead of Agent reachability", () => {
  const source = read("src/app/api/platform/stats/route.ts");
  assert.match(source, /printerStaleThresholdSeconds/);
  const printerBlock = source.split("db.select({\n        total: sql<number>`count(*) filter (where ${printers.inventoryPresent}")[1];
  assert.ok(printerBlock, "printer aggregate block missing");
  const beforeJobs = printerBlock.split("db.select({\n        total: sql<number>`count(*)::int`")[0];
  assert.match(beforeJobs, /\$\{printers\.lastSeenAt\} >= now\(\) - make_interval\(secs => \$\{printerStaleThresholdSeconds\(\)\}\)/);
  assert.match(beforeJobs, /\$\{printers\.status\} = 'online'/);
  assert.match(beforeJobs, /\$\{printers\.status\} = 'busy'/);
  assert.match(beforeJobs, /\$\{printers\.status\} = 'offline'/);
  assert.match(beforeJobs, /\$\{printers\.status\} = 'error'/);
  assert.match(beforeJobs, /unknown: sql<number>/);
  const onlineBucket = beforeJobs.split("online: sql<number>")[1].split("busy: sql<number>")[0];
  assert.doesNotMatch(onlineBucket, /\$\{agents\.(status|lastSeenAt|lifecycle)\}/,
    "physical printer Online must not depend on Agent connectivity");
});

test("platform agent aggregates do not label stale, missing, or inactive evidence Offline", () => {
  const source = read("src/app/api/platform/stats/route.ts");
  const agentStart = source.indexOf("active: sql<number>`count(*) filter (where ${agents.lifecycle} = 'active')");
  const printerStart = source.indexOf("total: sql<number>`count(*) filter (where ${printers.inventoryPresent}");
  assert.ok(agentStart >= 0 && printerStart > agentStart);
  const agentBlock = source.slice(agentStart, printerStart);
  assert.match(agentBlock, /offline:[\s\S]*\$\{agents\.status\} = 'offline'/);
  assert.match(agentBlock, /unknown:[\s\S]*\$\{agents\.lastSeenAt\} is null/);
  assert.match(agentBlock, /inactive:[\s\S]*\$\{agents\.lifecycle\} <> 'active'/);
});

test("platform UI presents uncertain fleet states as attention, not Offline", () => {
  const page = read("src/app/platform/dashboard/page.tsx");
  const charts = read("src/components/platform/overview-charts.tsx");
  assert.match(page, /agents=\{\{ attention:/);
  assert.match(page, /printers=\{\{\s*attention:/);
  assert.match(page, /healthy: \(stats\?\.printers\.online \?\? 0\) \+ \(stats\?\.printers\.busy \?\? 0\)/);
  assert.match(charts, /platform\.signal\.agentAttention/);
  assert.match(charts, /platform\.signal\.printerAttention/);
  assert.doesNotMatch(charts, /value:\s*printers\.offline/);
});
