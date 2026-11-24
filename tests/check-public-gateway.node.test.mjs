import { test } from "node:test";
import assert from "node:assert/strict";
import { publicGatewayOrigin } from "../scripts/check-public-gateway.mjs";

test("public Gateway acceptance refuses plaintext, credentials, subpaths and invalid origins", () => {
  assert.equal(publicGatewayOrigin("https://print.example.com/"), "https://print.example.com");
  assert.equal(publicGatewayOrigin("https://print.example.com:8443"), "https://print.example.com:8443");
  for (const invalid of [
    "http://print.example.com", "wss://print.example.com",
    "https://user:token@print.example.com",
    "https://print.example.com/api/health",
    "https://print.example.com/?secret=abc",
    "https://print.example.com/#section",
    "not a url",
  ]) {
    assert.throws(() => publicGatewayOrigin(invalid));
  }
});

test("public release acceptance uses strict HTTP and WSS certificate validation", async () => {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync("scripts/check-public-gateway.mjs", "utf8");
  assert.match(code, /redirect: "manual"/);
  assert.match(code, /health.status !== 200/);
  assert.match(code, /new WebSocket\("wss:\/\//);
  assert.match(code, /status === 401/);
  assert.doesNotMatch(code, /rejectUnauthorized:\s*false/);
});
