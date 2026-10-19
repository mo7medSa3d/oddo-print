import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

for (const [name, path, collection] of [
  ["members", "src/app/api/team/members/route.ts", "members"],
  ["invitations", "src/app/api/team/invitations/route.ts", "invitations"],
]) {
  test(`team ${name} GET is tenant-scoped, bounded, ordered, and timed`, () => {
    const source = read(path);
    assert.match(source, /clampListLimit\(searchParams\.get\("limit"\), 50, 100\)/);
    assert.match(source, /Number\.isSafeInteger\(offset\)/);
    assert.match(source, /offset > 1_000_000/);
    assert.match(source, /\.orderBy\(/);
    assert.match(source, /\.offset\(offset\)/);
    assert.match(source, /\.limit\(limit \+ 1\)/);
    assert.match(source, /queryWithTimeout\(/);
    assert.match(source, new RegExp(`${collection}: rows\\.slice\\(0, limit\\)`));
    assert.match(source, /hasMore: rows\.length > limit/);
    assert.match(source, /total: countRows\[0\]\?\.total \?\? 0/);
  });
}

test("Team UI requests bounded pages, exposes navigation, and uses server totals", () => {
  const source = read("src/app/team/page.tsx");
  assert.match(source, /const TEAM_PAGE_SIZE = 50/);
  assert.match(source, /\/api\/team\/members\?limit=\$\{TEAM_PAGE_SIZE\}&offset=\$\{requestedMemberOffset\}/);
  assert.match(source, /\/api\/team\/invitations\?limit=\$\{TEAM_PAGE_SIZE\}&offset=\$\{requestedInvitationOffset\}/);
  assert.match(source, /setMemberTotal\(/);
  assert.match(source, /setInvitationTotal\(/);
  assert.match(source, /common\.previousPage/);
  assert.match(source, /common\.nextPage/);
  assert.match(source, /team\.memberCount", memberTotal/);
  assert.match(source, /team\.inviteCount", invitationTotal/);
});

test("API reference documents the team pagination contract", () => {
  const source = read("API.md");
  assert.match(source, /Team collection reads are bounded and paginated/);
  assert.match(source, /default 50, maximum 100/);
});

test("Team page ordering has matching forward-migrated composite indexes", () => {
  const schema = read("src/db/schema.ts");
  const migration = read("drizzle/0079_team_collection_pagination_indexes.sql");
  const journal = read("drizzle/meta/_journal.json");
  const snapshot = read("drizzle/meta/0079_team_collection_pagination_indexes_snapshot.json");
  for (const name of [
    "tenant_users_tenant_created_user_idx",
    "tenant_invitations_tenant_created_id_idx",
  ]) {
    assert.match(schema, new RegExp(name));
    assert.match(migration, new RegExp(name));
    assert.match(snapshot, new RegExp(name));
  }
  assert.match(journal, /0079_team_collection_pagination_indexes/);
});
