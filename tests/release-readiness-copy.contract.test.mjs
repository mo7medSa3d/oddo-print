import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const client = fs.readFileSync("src/app/release-readiness/release-readiness-client.tsx", "utf8");

test("release decision summary is rendered once", () => {
  const matches = client.match(/t\("release\.summaryBody"\)/g) ?? [];
  assert.equal(matches.length, 1);
});
