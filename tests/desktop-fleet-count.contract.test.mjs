import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("../src/desktop/main.tsx", import.meta.url), "utf8");
const types = fs.readFileSync(new URL("../src/desktop/types.ts", import.meta.url), "utf8");
const tray = fs.readFileSync(new URL("../src-tauri/src/tray.rs", import.meta.url), "utf8");

test("retired Agent fleet screen is absent from desktop navigation and tray", () => {
  assert.doesNotMatch(main, /AgentsPage|page === "agents"/);
  assert.doesNotMatch(types, /"agents"/);
  assert.doesNotMatch(tray, /NAV_AGENT|#agents/);
});
