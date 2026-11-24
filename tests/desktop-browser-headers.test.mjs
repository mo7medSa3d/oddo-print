import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

// Retired license-only control plane removed fetchGatewayFleet and the browser-header bridge.
const hasFleetBridge = readFileSync("src/desktop/lib/ipc.ts", "utf8").includes("fetchGatewayFleet");
const ipcTest = hasFleetBridge ? test : test.skip;

ipcTest("direct-browser bridge preserves caller authorization and safe response pagination separately", async () => {
  const source = readFileSync("src/desktop/lib/ipc.ts", "utf8");
  const start = source.indexOf("async function gatewayConsoleRequest(");
  const end = source.indexOf("async function fetchGatewayFleet(", start);
  const headerSource = readFileSync("src/desktop/lib/gateway-headers.ts", "utf8").replace(/^export /gm, "");
  assert.ok(start >= 0 && end > start);
  let forwarded;
  const request = vm.runInNewContext(stripTypeScriptTypes(headerSource + "\n" + source.slice(start, end)) + "\ngatewayConsoleRequest", {
    TextEncoder,
    isTauri: false, normalizeGatewayUrl: url => url,
    fetchWithTimeout: async (_url, init) => {
      forwarded = init;
      return new Response("[]", { headers: {
        "x-has-more": "true", "x-next-before-id-encoded": "cDE", "set-cookie": "never-copy-this",
      } });
    },
  });
  const response = await request("https://gateway.example", "/api/printers", "GET", { Authorization: "Bearer test-manager-credential" });
  assert.equal(forwarded.headers.Authorization, "Bearer test-manager-credential");
  assert.equal(forwarded.credentials, "omit");
  assert.equal(response.headers["x-has-more"], "true");
  assert.equal(response.headers["x-next-before-id-encoded"], "cDE");
  assert.equal(response.headers["set-cookie"], undefined);
});

for (const isTauri of [false, true]) {
  ipcTest(`${isTauri ? "native" : "browser"} Gateway bridge rejects oversized continuation metadata`, async () => {
    const source = readFileSync("src/desktop/lib/ipc.ts", "utf8");
    const start = source.indexOf("async function gatewayConsoleRequest(");
    const end = source.indexOf("async function fetchGatewayFleet(", start);
    const headerSource = readFileSync("src/desktop/lib/gateway-headers.ts", "utf8").replace(/^export /gm, "");
    assert.ok(start >= 0 && end > start);
    const headers = { "x-has-more": "true", "x-next-cursor": "a".repeat(4097) };
    const request = vm.runInNewContext(stripTypeScriptTypes(headerSource + "\n" + source.slice(start, end)) + "\ngatewayConsoleRequest", {
      TextEncoder, isTauri, normalizeGatewayUrl: url => url,
      invoke: async () => JSON.stringify({ status: 200, body: "[]", headers }),
      fetchWithTimeout: async () => new Response("[]", { headers }),
    });
    await assert.rejects(request("https://gateway.example", "/api/printers"), /Invalid Gateway pagination metadata/);
  });
}

ipcTest("fleet pagination accepts legacy missing headers and rejects malformed modern cursors", async () => {
  const source = readFileSync("src/desktop/lib/ipc.ts", "utf8");
  const start = source.indexOf("function parseGatewayJson(");
  const end = source.indexOf("export function getAgentStatus(", start);
  assert.ok(start >= 0 && end > start);

  function fleetWith(response) {
    let calls = 0;
    const request = vm.runInNewContext(
      stripTypeScriptTypes(source.slice(start, end)) + "\nfetchGatewayFleet",
      {
        MAX_FLEET_PAGES: 25,
        MAX_FLEET_ROWS: 1000,
        URLSearchParams,
        gatewayHttpError: (_status, _body, fallback) => new Error(fallback),
        gatewayConsoleRequest: async () => {
          calls += 1;
          return response;
        },
      },
    );
    return { request, numberOfCalls: () => calls };
  }

  // Old Gateways that never supported pagination omit the envelope headers.
  const legacy = fleetWith({ status: 200, body: '[{"id":"printer-1"}]' });
  const rows = await legacy.request("https://gateway.example", "/api/printers");
  assert.equal(JSON.stringify(rows), '[{"id":"printer-1"}]');
  assert.equal(legacy.numberOfCalls(), 1);

  // New Gateways cannot advertise a next page without an exact cursor.
  const incomplete = fleetWith({ status: 200, body: '[{"id":"printer-1"}]', headers: { "x-has-more": "true" } });
  await assert.rejects(incomplete.request("https://gateway.example", "/api/printers"), /Invalid Gateway fleet cursor/);
  assert.equal(incomplete.numberOfCalls(), 1);

  const malformed = fleetWith({ status: 200, body: "[]", headers: { "x-has-more": "maybe" } });
  await assert.rejects(malformed.request("https://gateway.example", "/api/agents"), /Invalid Gateway fleet pagination metadata/);
  assert.equal(malformed.numberOfCalls(), 1);
});
