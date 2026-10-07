import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentsPath = "src/app/api/agents/route.ts";
const printersPath = "src/app/api/printers/route.ts";
const apiPath = "API.md";

async function sources() {
  return {
    agents: await readFile(agentsPath, "utf8"),
    printers: await readFile(printersPath, "utf8"),
    api: await readFile(apiPath, "utf8"),
  };
}

test("fleet list APIs keep bounded legacy offsets but provide keyset traversal", async () => {
  const { agents, printers } = await sources();
  for (const source of [agents, printers]) {
    assert.match(source, /MAX_[A-Z_]+_OFFSET\s*=\s*10_000/);
    assert.match(source, /beforeCreatedAt/);
    assert.match(source, /beforeId/);
    assert.match(source, /offset cannot be combined with keyset pagination/);
    assert.match(source, /\.limit\(limit \+ 1\)/);
    assert.match(source, /\.offset\(beforeCreatedAt \? 0 : offset\)/);
  }
});

test("keyset ordering has a deterministic identity tie breaker", async () => {
  const { agents, printers } = await sources();
  assert.match(agents, /orderBy\(desc\(agents\.createdAt\), desc\(agents\.id\)\)/);
  assert.match(agents, /lt\(agents\.createdAt, beforeCreatedAt\)[\s\S]*eq\(agents\.createdAt, beforeCreatedAt\)[\s\S]*lt\(agents\.id, beforeId\)/);
  assert.match(printers, /orderBy\(desc\(printers\.createdAt\), desc\(printers\.id\)\)/);
  assert.match(printers, /lt\(printers\.createdAt, beforeCreatedAt\)[\s\S]*eq\(printers\.createdAt, beforeCreatedAt\)[\s\S]*lt\(printers\.id, beforeId\)/);
});

test("fleet list responses preserve arrays and publish next-page evidence without caching", async () => {
  const { agents, printers } = await sources();
  for (const source of [agents, printers]) {
    assert.match(source, /NextResponse\.json\(responseRows/);
    assert.match(source, /"Cache-Control": "no-store"/);
    assert.match(source, /"X-Has-More"/);
    assert.match(source, /"X-Next-Before-Created-At"/);
    assert.match(source, /"X-Next-Before-Id"/);
  }
});

test("API documentation distinguishes request bounds from unlimited fleet cardinality", async () => {
  const { api } = await sources();
  assert.match(api, /resource entitlements may be `unlimited`/);
  assert.match(api, /keyset pagination/);
  assert.match(api, /beforeCreatedAt/);
  assert.match(api, /X-Next-Before-Id/);
});
