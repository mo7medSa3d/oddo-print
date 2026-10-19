import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const metrics = fs.readFileSync("src/lib/metrics.ts", "utf8");
const health = fs.readFileSync("src/lib/system-health.ts", "utf8");
const dashboard = fs.readFileSync("src/app/dashboard/page.tsx", "utf8");
const en = fs.readFileSync("src/i18n/messages/en.ts", "utf8");
const ar = fs.readFileSync("src/i18n/messages/ar.ts", "utf8");

test("Prometheus keeps physical printer evidence separate from Agent routability", () => {
  assert.match(metrics, /printers_online \$\{p\.online\}/);
  assert.match(metrics, /printers_busy \$\{p\.busy\}/);
  assert.match(metrics, /printers_offline \$\{p\.offline\}/);
  assert.match(metrics, /printers_error \$\{p\.error\}/);
  assert.match(metrics, /printers_stale \$\{p\.stale\}/);
  assert.match(metrics, /printers_unknown \$\{p\.unknown\}/);
  assert.match(metrics, /printers_routable \$\{p\.routable\}/);
  assert.match(metrics, /p\.status = 'offline' AND printer_fresh/);
  assert.match(metrics, /p\.status IN \('online', 'busy'\)[\s\S]*agent_fresh[\s\S]*AS routable/);
});

test("Agent offline does not swallow stale or missing-heartbeat evidence", () => {
  assert.match(metrics, /status = 'offline' AND fresh/);
  assert.match(metrics, /last_seen_at IS NOT NULL AND NOT fresh[\s\S]*AS stale/);
  assert.match(metrics, /last_seen_at IS NULL[\s\S]*AS unknown/);
  assert.match(metrics, /agents_unknown \$\{a\.unknown\}/);
});

test("system health names the cross-component predicate as availability, not physical online", () => {
  assert.match(health, /as routable/);
  assert.match(health, /messageKey: "health\.printersAvailable"/);
  assert.match(health, /printers available for jobs/);
  assert.doesNotMatch(health, /messageKey: "health\.printersOnline"/);
  assert.match(en, /"health\.printersAvailable": "\{available\} of \{total\} printers available for jobs\."/);
  assert.match(ar, /"health\.printersAvailable":/);
});

test("dashboard database success is described as a snapshot, not a live stream", () => {
  assert.match(dashboard, /dashboard\.page\.snapshotLoaded/);
  assert.match(dashboard, /pulse=\{false\}/);
  assert.doesNotMatch(dashboard, /dashboard\.page\.live/);
  assert.match(en, /"dashboard\.page\.snapshotLoaded": "Snapshot loaded"/);
  assert.match(ar, /"dashboard\.page\.snapshotLoaded":/);
});
