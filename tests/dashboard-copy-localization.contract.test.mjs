import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const dashboard = fs.readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
const en = fs.readFileSync("src/i18n/messages/en.ts", "utf8");
const ar = fs.readFileSync("src/i18n/messages/ar.ts", "utf8");

test("dashboard job delivery metadata uses catalog pluralization in every locale", () => {
  assert.match(dashboard, /tc\("job\.attempts", job\.deliveryAttempts \?\? 0\)/);
  assert.match(dashboard, /tc\("job\.retries", job\.retries\)/);
  assert.doesNotMatch(dashboard, /attempt\{\(job\.deliveryAttempts/);
  assert.doesNotMatch(dashboard, /retr\$\{job\.retries/);
  assert.match(en, /"job\.attempts\.one"/);
  assert.match(en, /"job\.retries\.other"/);
  assert.match(ar, /"job\.attempts\.one"/);
  assert.match(ar, /"job\.attempts\.two"/);
  assert.match(ar, /"job\.retries\.other"/);
});
