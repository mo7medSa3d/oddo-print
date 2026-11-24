import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const read = p => fs.readFileSync(p, "utf8");

test("workspace member list is tenant-scoped and bounded independently of invitation mutations", () => {
  const source = read("src/app/api/team/members/route.ts");
  for (const pattern of [
    /clampListLimit\(searchParams\.get\("limit"\), 50, 100\)/,
    /parseStrictListOffset\(searchParams\.get\("offset"\), 1_000_000\)/, /\.orderBy\(/, /\.offset\(offset\)/,
    /\.limit\(limit \+ 1\)/, /queryWithTimeout\(/,
    /hasMore: rows\.length > limit/, /total: countRows\[0\]\?\.total \?\? 0/
  ]) assert.match(source, pattern);
});
test("workspace invitations are scoped and use verified owner session authorization", () => {
  const old = read("src/app/api/team/invitations/route.ts");
  const platform = read("src/app/api/platform/tenants/[id]/invitations/route.ts");
  assert.match(old, /requireWorkspaceOwnerForInvites/);
  assert.match(old, /eq\(tenantInvitations.tenantId, claims.tenantId\)/);
  assert.match(old, /export async function GET/);
  assert.match(old, /assertPlatformTeamOrigin/);
  assert.match(old, /role: "admin"/);
  assert.match(platform, /status: 410/);
  assert.doesNotMatch(platform, /sendTransactionalEmail/);
});
test("workspace Team UI uses a session with no new password prompt or role selector", () => {
  const page = read("src/app/team/page.tsx");
  assert.match(page, /const PAGE_SIZE = 50/);
  assert.match(page, /\/api\/team\/members\?limit=/);
  assert.match(page, /hasMore/);
  assert.match(page, /common\.nextPage/);
  assert.doesNotMatch(page, /updateRole\(|roleOptions\(|<Select/);
  assert.match(page, /\/api\/team\/invitations\?limit=/);
  assert.match(page, /fetchWithSessionRetry/);
  assert.doesNotMatch(page, /verifyPlatformOwnerPassword|type="password"/);
});
test("DB indexes for current membership and historical invitations are preserved", () => {
  const schema = read("src/db/schema.ts");
  const migration = read("drizzle/0000_initial_schema.sql");
  const journal = read("drizzle/meta/_journal.json");
  const snapshot = read("drizzle/meta/0000_initial_schema_snapshot.json");
  for (const name of ["tenant_users_tenant_created_user_idx","tenant_invitations_tenant_created_id_idx"]) {
    assert.match(schema,new RegExp(name));
    assert.match(migration,new RegExp(name));
    assert.match(snapshot,new RegExp(name));
  }
  assert.match(journal,/0000_initial_schema/);
});
