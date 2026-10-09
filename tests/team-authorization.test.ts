import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbTx } from "../src/db";
import { requireTeamActorInTransaction, TeamAuthorizationChangedError } from "../src/lib/team-authorization";

const dialect = new PgDialect();
function database(role: string | null, active: boolean) {
  const statements: string[] = [];
  const tx = {
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const sql = dialect.sqlToQuery(query).sql;
      statements.push(sql);
      return { rows: /FROM (refresh_tokens|manager_sessions)/.test(sql) && active ? [{ id: "session" }] : [] };
    },
    query: { tenantUsers: { findFirst: async () => role ? { role } : undefined } },
  } as unknown as DbTx;
  return { tx, statements };
}
const actor = { userId: "admin", tenantId: "workspace", role: "admin" as const,
  kind: "manager" as const, sub: "manager" as const, jti: "a".repeat(32),
  familyId: "f".repeat(32), iat: 1, exp: 9999999999 };

describe("transactional team authority", () => {
  it.each(["viewer", "operator", null])("denies a removed/demoted actor (%s) before mutation", async role => {
    const { tx } = database(role, true);
    await expect(requireTeamActorInTransaction(tx, actor, ["target"])).rejects.toBeInstanceOf(TeamAuthorizationChangedError);
  });
  it("denies a revoked family even when membership still grants permission", async () => {
    const { tx } = database("admin", false);
    await expect(requireTeamActorInTransaction(tx, actor)).rejects.toBeInstanceOf(TeamAuthorizationChangedError);
  });
  it("allows a current administrator with a live family and orders shared user locks", async () => {
    const { tx, statements } = database("admin", true);
    await expect(requireTeamActorInTransaction(tx, actor, ["target", "admin"])).resolves.toBeUndefined();
    expect(statements[0]).toContain("ORDER BY id FOR UPDATE");
    expect(statements.at(-1)).toContain("FOR SHARE");
  });
  it("preserves live legacy sessions and denies revoked legacy sessions", async () => {
    const legacy = { ...actor, familyId: undefined };
    await expect(requireTeamActorInTransaction(database("admin", true).tx, legacy)).resolves.toBeUndefined();
    await expect(requireTeamActorInTransaction(database("admin", false).tx, legacy)).rejects.toBeInstanceOf(TeamAuthorizationChangedError);
  });
});
