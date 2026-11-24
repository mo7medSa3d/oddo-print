import { describe, expect, it } from "vitest";
import type { DbTx } from "../src/db";
import { requireTeamActorInTransaction, TeamAuthorizationChangedError } from "../src/lib/team-authorization";

const actor = { userId: "actor", tenantId: "tenant", role: "owner" as const,
  kind: "manager" as const, sub: "manager" as const, jti: "a".repeat(32),
  ver: 2 as const, sid: "b".repeat(32), familyId: "f".repeat(32),
  iat: 1, exp: 9999999999 };
const tx = { execute: async () => { throw new Error("Team route must not touch database"); } } as unknown as DbTx;

describe("retired workspace team mutation authority", () => {
  it.each(["owner", "admin", "viewer", "operator", "integration_admin", "billing_admin"] as const)(
    "%s cannot invoke the former workspace team mutation guard", async role => {
      await expect(requireTeamActorInTransaction(tx, { ...actor, role }, ["other-user"]))
        .rejects.toBeInstanceOf(TeamAuthorizationChangedError);
    });
  it("revoked and legacy sessions also cannot mutate team membership", async () => {
    for (const claim of [
      { ...actor, familyId: undefined, ver: undefined, sid: undefined },
      { ...actor, familyId: "revoked-id", sid: "revoked-token" },
    ]) {
      await expect(requireTeamActorInTransaction(tx, claim as typeof actor))
        .rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_CHANGED" });
    }
  });
});
