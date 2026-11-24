import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbTx } from "../src/db";
import {
  requirePlatformActorInTransaction,
  PlatformMutationAuthorityChangedError,
  type PlatformOwnerClaims,
} from "../src/lib/platform-auth";

const dialect = new PgDialect();
const actor: PlatformOwnerClaims = {
  userId: "platform-owner", email: "owner@example.test", sub: "platform_owner",
  jti: "a".repeat(32), sid: "b".repeat(32), familyId: "c".repeat(32),
  iat: 1, exp: 901, ver: 2, kind: "platform",
};

function database(overrides = {}, sessionActive = true) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const compiled = dialect.sqlToQuery(query);
      statements.push({ sql: compiled.sql, params: compiled.params });
      if (/FROM users/.test(compiled.sql)) return { rows: [{
        id: actor.userId, email: actor.email, isPlatformOwner: true,
        emailVerifiedAt: new Date(), ...overrides,
      }] };
      return { rows: /FROM (refresh_tokens|platform_sessions)/.test(compiled.sql) && sessionActive ? [{ id: "live" }] : [] };
    },
  } as unknown as DbTx;
  return { tx, statements };
}

describe("fresh transactional platform authority", () => {
  it("holds the current owner then family/session and uses exact tenantless identity plus DB expiry", async () => {
    const { tx, statements } = database();
    await expect(requirePlatformActorInTransaction(tx, actor)).resolves.toBeUndefined();
    expect(statements[0].sql).toContain("FROM users");
    expect(statements[0].sql).toContain("FOR UPDATE");
    expect(statements[0].params).toEqual([actor.userId]);
    expect(statements[1].sql).toContain("pg_advisory_xact_lock");
    const session = statements[2];
    expect(session.sql).toContain("kind = 'platform'");
    expect(session.sql).toContain("tenant_id IS NULL");
    expect(session.sql).toContain("revoked_at IS NULL");
    expect(session.sql).toContain("expires_at > clock_timestamp()");
    expect(session.sql).toContain("FOR SHARE");
    expect(session.params).toEqual([actor.familyId, actor.sid, actor.userId, actor.email, actor.exp, actor.iat]);
  });

  it.each([
    { isPlatformOwner: false },
    { isPlatformOwner: "true" },
    { emailVerifiedAt: null },
    { email: "replaced@example.test" },
  ])("denies changed live principal %j before session admission", async override => {
    const { tx, statements } = database(override);
    await expect(requirePlatformActorInTransaction(tx, actor)).rejects.toBeInstanceOf(PlatformMutationAuthorityChangedError);
    expect(statements).toHaveLength(1);
  });

  it("denies a revoked or expired family after current owner verification", async () => {
    await expect(requirePlatformActorInTransaction(database({}, false).tx, actor))
      .rejects.toBeInstanceOf(PlatformMutationAuthorityChangedError);
  });

  it("rejects legacy platform sessions because they have no persisted password/session policy", async () => {
    const legacy: PlatformOwnerClaims = { ...actor, ver: undefined, kind: undefined, sid: undefined, familyId: undefined };
    const { tx, statements } = database();
    await expect(requirePlatformActorInTransaction(tx, legacy)).rejects.toBeInstanceOf(PlatformMutationAuthorityChangedError);
    expect(statements).toHaveLength(1);
    await expect(requirePlatformActorInTransaction(database({}, false).tx, legacy))
      .rejects.toBeInstanceOf(PlatformMutationAuthorityChangedError);
  });

  it("does not downgrade a malformed versioned session into legacy authority", async () => {
    const { tx, statements } = database();
    await expect(requirePlatformActorInTransaction(tx, { ...actor, familyId: undefined }))
      .rejects.toBeInstanceOf(PlatformMutationAuthorityChangedError);
    expect(statements).toHaveLength(1);
  });
});
