import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

test("browser preview supports the current credential-free Gateway probe and tray locale", async () => {
  const source = readFileSync("src/desktop/preview/mock-tauri.ts", "utf8")
    .replace("export function installPreviewBackend", "function installPreviewBackend");
  const window = { fetch: async () => { throw new Error("unexpected external request"); } };
  vm.runInNewContext(stripTypeScriptTypes(source), { window, URL, Response, setTimeout, console });
  const probe = await window.__TAURI_INTERNALS__.invoke("probe_gateway_health", { url: "https://preview.example" });
  assert.equal(probe.status, 200);
  assert.deepEqual(JSON.parse(probe.body), { ok: true, service: "yaseir-print-gateway" });
  await window.__TAURI_INTERNALS__.invoke("set_tray_locale", { locale: "ar" });
});
