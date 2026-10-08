import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("src/lib/job-maintenance.ts", "utf8");
const retention = source.match(/const parsedLimit = Number\(process\.env\.JOB_RETENTION_SWEEP_LIMIT\);[\s\S]*?const limit = ([\s\S]*?);/);
const maintenance = source.match(/const parsedLimit = Number\(process\.env\.MAINTENANCE_SWEEP_LIMIT\);[\s\S]*?const SWEEP_BATCH = ([\s\S]*?);/);
assert.ok(retention && maintenance);

function configuredLimit(expression, envKey, value) {
  const context = {process: {env: {[envKey]: value}}, Number, Math, DEFAULT_RETENTION_BATCH: 500};
  return runInNewContext(`(() => { const parsedLimit = Number(process.env.${envKey}); return (${expression}); })()`, context);
}

for (const [name, expression, env, fallback] of [
  ["retention", retention[1], "JOB_RETENTION_SWEEP_LIMIT", 500],
  ["maintenance", maintenance[1], "MAINTENANCE_SWEEP_LIMIT", 200],
]) {
  test(`${name} fractional and invalid values never disable recovery`, () => {
    assert.ok(configuredLimit(expression, env, "0.5") >= 1);
    assert.equal(configuredLimit(expression, env, "-3"), fallback);
    assert.equal(configuredLimit(expression, env, "bad"), fallback);
  });
  test(`${name} oversized values cannot trigger unbounded updates`, () => {
    assert.ok(configuredLimit(expression, env, "1000000000") <= 5000);
    assert.equal(configuredLimit(expression, env, "10"), 10);
  });
}
