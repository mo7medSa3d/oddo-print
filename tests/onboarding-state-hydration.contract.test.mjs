import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const ui = fs.readFileSync("src/app/onboarding/page.tsx", "utf8");
const workspace = fs.readFileSync("src/app/api/onboarding/route.ts", "utf8");
const request = fs.readFileSync("src/app/api/subscription-requests/route.ts", "utf8");
test("legacy setup leads to workspace billing, not the Platform Admin", () => {
  assert.match(ui, /redirect\(suffix \? `\/billing\?\$\{suffix\}` : "\/billing"\)/);
  assert.doesNotMatch(ui, /fetchWithTimeout|subscription-requests|\/api\/onboarding/);
  assert.match(workspace, /PLATFORM_OWNER_REQUIRED/);
  assert.match(request, /requireManagerActorInTransaction/);
  assert.match(request, /requireIdempotencyKey/);
});
test("platform commercial controls remain separate from a workspace session", () => {
  const platform = fs.readFileSync("src/app/api/platform/subscriptions/route.ts", "utf8");
  assert.match(platform, /requirePlatformOwner/);
  assert.doesNotMatch(platform, /validateWorkspaceManager/);
});
