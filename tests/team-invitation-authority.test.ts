import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({ role: "admin", live: true, lifecycle: "active",
  statements: [] as string[], inserts: 0, emails: 0 }));
const dialect = new PgDialect();
const tx = {
  execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const statement = dialect.sqlToQuery(query).sql;
    state.statements.push(statement);
    if (statement.includes("FROM tenants")) return { rows: [{ id: "workspace", lifecycle: state.lifecycle }] };
    if (statement.includes("FROM refresh_tokens")) return { rows: state.live ? [{ id: "live-session" }] : [] };
    return { rows: [] };
  },
  query: { tenantUsers: { findFirst: async () => ({ role: state.role }) },
    tenantInvitations: { findFirst: async () => undefined } },
  insert: () => ({ values: async () => { state.inserts++; } }),
};
vi.mock("../src/db", () => ({ db: { transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } }));
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: async () => ({
  tenantId: "workspace", userId: "actor", role: "admin", kind: "manager", sub: "manager",
  familyId: "f".repeat(32), jti: "a".repeat(32), iat: 1, exp: 9999999999,
}) }));
vi.mock("../src/lib/email", () => ({ appBaseUrl: () => "https://audit.invalid",
  sendTransactionalEmail: async () => { state.emails++; } }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));
vi.mock("../src/i18n/server", () => ({ getServerLocale: async () => "en", makeT: () => (key: string) => key }));
import { POST } from "../src/app/api/team/invitations/route";

function request() {
  return new Request("http://gateway.test/api/team/invitations", { method: "POST",
    body: JSON.stringify({ email: "synthetic@example.invalid", role: "viewer" }) });
}
describe("invitation actor authority and lifecycle lock ordering", () => {
  beforeEach(() => { state.role = "admin"; state.live = true; state.lifecycle = "active";
    state.statements.length = 0; state.inserts = 0; state.emails = 0; });
  it("locks tenant before users/family/session, consistent with suspension, and commits one invitation", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(state.statements[0]).toContain("FROM tenants");
    expect(state.statements[1]).toContain("FROM users");
    expect(state.statements[2]).toContain("pg_advisory_xact_lock");
    expect(state.statements[3]).toContain("FROM refresh_tokens");
    expect(state.inserts).toBe(1);
    expect(state.emails).toBe(1);
  });
  it.each(["viewer", "operator"])("does not invite or send email using a demoted actor (%s)", async role => {
    state.role = role;
    expect((await POST(request())).status).toBe(403);
    expect(state.statements[0]).toContain("FROM tenants");
    expect(state.inserts).toBe(0);
    expect(state.emails).toBe(0);
  });
  it("does not invite or send email using a revoked family", async () => {
    state.live = false;
    expect((await POST(request())).status).toBe(403);
    expect(state.inserts).toBe(0);
    expect(state.emails).toBe(0);
  });
  it("rejects a suspended tenant before acquiring session locks", async () => {
    state.lifecycle = "suspended";
    expect((await POST(request())).status).toBe(409);
    expect(state.statements).toEqual([expect.stringContaining("FROM tenants")]);
    expect(state.inserts).toBe(0);
    expect(state.emails).toBe(0);
  });
});
