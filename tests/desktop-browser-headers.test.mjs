import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

test("direct-browser bridge preserves caller authorization and safe response pagination separately", async () => {
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
  test(`${isTauri ? "native" : "browser"} Gateway bridge rejects oversized continuation metadata`, async () => {
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
