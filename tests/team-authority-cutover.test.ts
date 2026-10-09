import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({ targetRole: "admin", callerRole: "admin", statements: [] as string[], sessionRevoked: false }));
const dialect = new PgDialect();
const tx = {
  execute: async (query: any) => { state.statements.push(dialect.sqlToQuery(query).sql); return { rows: [] }; },
  query: { tenantUsers: { findFirst: async () => ({ role: state.targetRole }) } },
  update: (table: any) => ({ set: (values: any) => ({ where: () => ({ returning: async () => {
    expect(getTableName(table)).toBe("tenant_users");
    state.targetRole = values.role;
    return [{ userId: "admin_repro" }];
  } }) }) }),
};
vi.mock("../src/db", () => ({ db: { transaction: async (fn: any) => fn(tx) } }));
// The authentication boundary returns the snapshot it read before revocation.
// In the exact schedule modeled here the owner's demotion has committed by
// the time this already-authorized request enters its mutation transaction.
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: async () => {
  const claims = { tenantId: "tenant_repro", userId: "admin_repro", role: state.callerRole, familyId: "f".repeat(32) };
  state.targetRole = "viewer";
  state.sessionRevoked = true;
  return claims;
} }));
vi.mock("../src/lib/session-tokens", () => ({ revokeUserTenantRefreshFamiliesInTransaction: async () => {} }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));
vi.mock("../src/db/client", () => ({ queryWithTimeout: async (fn: any) => fn() }));
import { PATCH } from "../src/app/api/team/members/route";

describe("team actor authority at mutation commit", () => {
  beforeEach(() => { state.targetRole = "admin"; state.callerRole = "admin"; state.statements.length = 0; state.sessionRevoked = false; });
  it("rejects a pending self-role PATCH after owner demotion and family revocation", async () => {
    const response = await PATCH(new Request("http://gateway.test/api/team/members", { method: "PATCH", body: JSON.stringify({ userId: "admin_repro", role: "admin" }) }));
    expect(state.sessionRevoked).toBe(true);
    expect(response.status).toBe(403);
    expect(state.targetRole).toBe("viewer");
    // The live actor read fails before any target mutation or session grant.
    expect(state.statements).toEqual([expect.stringContaining("ORDER BY id FOR UPDATE")]);
  });
});
