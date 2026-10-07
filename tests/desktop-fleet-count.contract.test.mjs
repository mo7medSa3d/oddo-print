import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/desktop/pages/Agents.tsx", import.meta.url), "utf8");

test("desktop fleet detail includes online numerator before localized total", () => {
  assert.match(source, /\{s\.fleetOnline \?\? 0\}<\/span>[\s\S]*desktop\.agents\.ofTotal/);
});
