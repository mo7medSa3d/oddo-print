import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const health = readFileSync("src/lib/system-health.ts", "utf8");
const route = readFileSync("src/app/api/system/health/route.ts", "utf8");
const workflow = readFileSync(".github/workflows/build-windows.yml", "utf8");

test("health API never reflects raw PostgreSQL exception text to workspace users", () => {
  assert.match(route, /NextResponse\.json\(health/);
  for (const [check, message] of [
    ["Database", "Database health check unavailable"],
    ["Queue", "Queue health check unavailable"],
    ["Agents", "Agent health check unavailable"],
    ["Printers", "Printer health check unavailable"],
  ]) {
    assert.match(health, new RegExp(`name: "${check}", state: "(?:error|unknown)"[^\n]*message: "${message}"`));
  }
  assert.doesNotMatch(health, /String\(e\)\.slice\(0, 200\)/);
  assert.doesNotMatch(health, /message: `(?:DB unreachable|Queue check failed|Agent check failed|Printer check failed)/);
  assert.match(health, /reportHealthLookupError\("database", e\)/);
  assert.match(health, /errorCode: code/);
});

test("failing Windows acceptance retains a distinctly unverified diagnostic artifact", () => {
  const verified = workflow.indexOf("- name: Upload Windows NSIS installer");
  const fallback = workflow.indexOf("- name: Upload unverified Windows installer for diagnostics");
  assert.ok(verified > 0 && fallback > verified);
  assert.match(workflow.slice(fallback), /if: failure\(\)/);
  assert.match(workflow.slice(fallback), /Yaseir-Manager-Windows-NSIS-UNVERIFIED-DIAGNOSTIC/);
  assert.match(workflow.slice(fallback), /if-no-files-found: ignore/);
  assert.match(workflow.slice(verified, fallback), /if-no-files-found: error/);
});
