import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("agent health collection bounds fleet cardinality before per-Agent fan-out", () => {
  const health = read("src/lib/agent-health.ts");
  assert.match(health, /getAllAgentsHealth\(tenantId: string, limit = 100, offset = 0\)/);
  assert.match(health, /\.orderBy\(asc\(agents\.id\)\)/);
  assert.match(health, /\.limit\(boundedLimit\)/);
  assert.match(health, /\.offset\(boundedOffset\)/);
});

test("agent health route preserves array response while exposing bounded pagination evidence", () => {
  const route = read("src/app/api/agents/health/route.ts");
  assert.match(route, /limit > 200/);
  assert.match(route, /offset > 100_000/);
  assert.match(route, /getAllAgentsHealth\(claims\.tenantId, limit \+ 1, offset\)/);
  assert.match(route, /"x-has-more": String\(hasMore\)/);
  assert.match(route, /"x-next-offset": String\(offset \+ limit\)/);
  assert.match(route, /return NextResponse\.json\(all,/);
});
