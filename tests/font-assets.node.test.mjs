import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const layout = readFileSync(resolve("src/app/layout.tsx"), "utf8");
const css = readFileSync(resolve("src/app/globals.css"), "utf8");
const expected = {
  "ibm-plex-sans-variable.ttf": "30f837e8b02e8ecddce6cbebc425b1f422392515",
  "ibm-plex-sans-arabic-400.ttf": "e779068718b9801b809605b2bf3067121cce524c",
  "ibm-plex-sans-arabic-500.ttf": "e82313893b5b5b6af3e7429f5b798666f1e0b097",
  "ibm-plex-sans-arabic-600.ttf": "f7a7fc87747a9ddabb3557d4a3f4140a7a1460b0",
  "ibm-plex-sans-arabic-700.ttf": "211ff62d8d1778bff69a1b3a906b2ad1686564bc",
};

test("Gateway fonts do not depend on Google Fonts at production build time", () => {
  assert.match(layout, /from "next\\/font\\/local"/);
  assert.doesNotMatch(layout, /next\\/font\\/google/);
  assert.match(layout, /variable: "--font-ibm-plex-sans"/);
  assert.match(layout, /variable: "--font-ibm-plex-sans-arabic"/);
  assert.match(css, /--font-ibm-plex-sans/);
  assert.match(css, /--font-ibm-plex-sans-arabic/);
});

test("all pinned IBM Plex fonts are local, non-empty and bit-identical to reviewed upstream", () => {
  for (const [file, sha] of Object.entries(expected)) {
    const path = resolve("src/app/fonts", file);
    assert.ok(existsSync(path), "Missing "+file);
    const bytes = readFileSync(path);
    assert.ok(bytes.length > 100_000, "Unexpectedly short font file: "+file);
    assert.equal(bytes.subarray(0, 4).toString("hex"), "00010000", "TTF signature mismatch: "+file);
    const gitSha = createHash("sha1")
      .update(Buffer.from("blob "+bytes.length+"\\0"))
      .update(bytes).digest("hex");
    assert.equal(gitSha, sha, "Upstream asset digest mismatch for "+file);
    assert.ok(layout.includes(file), "Not included in Next local fonts: "+file);
  }
  const license = readFileSync(resolve("src/app/fonts/OFL.txt"), "utf8");
  assert.match(license, /SIL OPEN FONT LICENSE/);
});
