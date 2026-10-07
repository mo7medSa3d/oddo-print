import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("dashboard job Server Action keeps deep offset and search bounds", () => {
  const source = read("src/app/actions.ts");
  const start = source.indexOf("const DASHBOARD_JOBS_MAX_OFFSET");
  const end = source.indexOf("async function dashboardResult", start);
  assert.ok(start >= 0 && end > start, "dashboard job action block missing");
  const block = source.slice(start, end);
  assert.match(block, /DASHBOARD_JOBS_MAX_OFFSET = 10_000/);
  assert.match(block, /DASHBOARD_JOBS_MAX_SEARCH_LENGTH = 64/);
  assert.match(block, /Number\.isSafeInteger\(requestedOffset\)/);
  assert.match(block, /requestedOffset > DASHBOARD_JOBS_MAX_OFFSET/);
  assert.match(block, /searchParam\.length < 2/);
  assert.match(block, /searchParam\.length > DASHBOARD_JOBS_MAX_SEARCH_LENGTH/);
});

test("dashboard UI does not issue one-character server searches and caps normal input", () => {
  const source = read("src/app/dashboard/dashboard-client.tsx");
  assert.match(source, /setDebouncedJobSearch\(normalized\.length === 1 \? "" : normalized\)/);
  assert.match(source, /maxLength=\{64\}/);
});
