import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// v9-font: Thmanyah Sans is served from the Gateway origin via
// next/font/local, with IBM Plex kept as the fallback. This test pins the
// new state without parsing font binaries: file presence, WOFF2 signature,
// the weight mapping in layout.tsx, the stack order (v10-exact: the stacks
// live in the shared typography/tokens.css, which globals.css imports —
// not in a Gateway-only override anymore), and the surviving IBM
// fallback. Full cmap proof lives in
// scripts/check-thmanyah-coverage.py (fontTools, run in the gate report).
const layout = readFileSync(resolve("src/app/layout.tsx"), "utf8");
const css = readFileSync(resolve("src/app/globals.css"), "utf8");
const tokens = readFileSync(resolve("typography/tokens.css"), "utf8");
const odooTokens = readFileSync(
  resolve("odoo_addons/print_gateway/static/src/css/typography_tokens.css"),
  "utf8",
);

const WEIGHTS = [
  ["thmanyahsans-Light.woff2", "300"],
  ["thmanyahsans-Regular.woff2", "400"],
  ["thmanyahsans-Medium.woff2", "500"],
  ["thmanyahsans-Bold.woff2", "700"],
  ["thmanyahsans-Black.woff2", "900"],
];

test("all five served Thmanyah WOFF2 files exist and are real WOFF2", () => {
  for (const [file] of WEIGHTS) {
    const path = resolve("src/app/fonts/thmanyah", file);
    assert.ok(existsSync(path), "Missing " + file);
    const bytes = readFileSync(path);
    assert.ok(bytes.length > 10_000, "Unexpectedly short web font file: " + file);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2", "WOFF2 signature mismatch: " + file);
    assert.ok(layout.includes(file), "Not included in Next local fonts: " + file);
  }
});

test("layout maps every Thmanyah weight under one --font-thmanyah variable", () => {
  assert.match(layout, /variable: "--font-thmanyah"/);
  assert.match(layout, /display: "block"/);
  for (const [file, weight] of WEIGHTS) {
    assert.ok(
      layout.includes(`./fonts/thmanyah/${file}`) && layout.includes(`weight: "${weight}"`),
      `Weight ${weight} (${file}) not mapped in layout.tsx`,
    );
  }
  assert.ok(layout.includes("thmanyahSans.variable"), "Thmanyah variable not applied to <html>");
});

test("shared typography spec leads both stacks with served Thmanyah, IBM Plex second", () => {
  // v10-exact moved the stacks from the old globals.css override into
  // the shared spec; globals.css reaches them through its import.
  assert.ok(css.includes('@import "../../typography/tokens.css";'), "globals.css does not import the shared spec");
  assert.equal(odooTokens, tokens, "Odoo token copy drifted from canonical");
  assert.ok(
    tokens.includes('--typo-font-latin: var(--font-thmanyah, "Thmanyah Sans"), var(--font-ibm-plex-sans, "IBM Plex Sans");'),
    "Latin stack does not lead with served Thmanyah",
  );
  assert.ok(
    tokens.includes('--typo-font-arabic: var(--font-thmanyah, "Thmanyah Sans"), var(--font-ibm-plex-sans-arabic, "IBM Plex Sans Arabic");'),
    "Arabic stack does not lead with served Thmanyah",
  );
  // IBM Plex fallback files are NOT deleted.
  for (const file of ["ibm-plex-sans-variable.woff2", "ibm-plex-sans-arabic-400.woff2"]) {
    assert.ok(existsSync(resolve("src/app/fonts", file)), "Fallback deleted: " + file);
    assert.ok(layout.includes(file), "Fallback not loaded: " + file);
  }
  // No external font CDN for product UI.
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.ok(!layout.includes('from "next/font/google"'));
});

test("no stale no-Thmanyah claim remains in the Gateway font comments", () => {
  assert.ok(!layout.includes("Thmanyah Sans is NOT loaded"));
  assert.ok(!css.includes("ships\n   NO Thmanyah files") && !css.includes("NO Thmanyah files"));
  assert.ok(!css.includes("prohibits web embedding"));
});
