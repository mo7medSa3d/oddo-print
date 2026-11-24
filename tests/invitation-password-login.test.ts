import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL } from "drizzle-orm";

const state = vi.hoisted(() => ({
  identity: null as { userId: string; email: string; credentialVersion: string; memberships: never[]; multipleTenants: false } | null,
  invite: {} as Record<string, unknown>, user: {} as Record<string, unknown>, lifecycle: "active",
  member: false, accepted: false, issueFailure: false,
}));
const dialect = new PgDialect();
const compile = (query: SQL) => dialect.sqlToQuery(query);

// Password verification and session encoding have dedicated native-KDF suites.
// This route exercises the real invitation join and locked credential fence.
vi.mock("../src/lib/customer-auth", () => ({
  authenticateForTenant: async () => state.identity,
  issueCustomerSession: async () => { throw new Error("No existing workspace"); },
  customerSessionCookie: () => "cust_session=invited-session; Path=/; HttpOnly",
  customerRefreshCookie: () => "cust_refresh=invited-refresh; Path=/api/auth/refresh; HttpOnly",
}));
vi.mock("../src/lib/session-tokens", async importActual => ({
  ...await importActual<typeof import("../src/lib/session-tokens")>(),
  issueSessionPairInTransaction: async () => {
    if (state.issueFailure) throw new Error("Session persistence unavailable");
    return { familyId: "new-family", accessExpiresAt: new Date("2030-01-01T00:00:00Z") };
  },
  sessionReplacementFromRequest: () => undefined,
}));
vi.mock("../src/lib/auth-rate-limit", () => ({
  reserveAuthAttempt: async () => ({ allowed: true }), clientIpFrom: () => "198.51.100.10",
  recordAuthSuccess: async () => {}, setRateLimitHeaders: (res: Response) => res,
}));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));
vi.mock("../src/db", () => {
  const invite = () => state.accepted || state.invite.revokedAt || Number(state.invite.expiresAt) <= Date.now() ? null : state.invite;
  const tx = {
    query: {
      tenantInvitations: { findFirst: async ({ where }: { where: SQL }) => {
        const p = compile(where).params;
        return (p[0] === state.invite.id || p[0] === state.invite.tokenHash) ? invite() : null;
      } },
      users: { findFirst: async () => state.user },
      tenantUsers: { findFirst: async () => state.member ? { userId: state.user.id } : null },
    },
    execute: async (statement: SQL) => {
      const { sql } = compile(statement);
      if (sql.includes("FROM tenants")) return { rows: [{ id: "invited", lifecycle: state.lifecycle }] };
      if (sql.includes("FROM users")) return { rows: [state.user] };
      throw new Error("Unexpected invitation SQL");
    },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => {
      if (!invite()) return [];
      state.accepted = true; return [{ id: state.invite.id }];
    } }) }) }),
    insert: (table: Parameters<typeof getTableName>[0]) => {
      if (getTableName(table) !== "tenant_users") throw new Error("Invitation must never create a tenant");
      return { values: () => ({ onConflictDoNothing: () => ({ returning: async () => {
        state.member = true; return [{ userId: state.user.id }];
      } }) }) };
    },
  };
  return { db: { query: tx.query, transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
    const before = { accepted: state.accepted, member: state.member };
    try { return await fn(tx); } catch (error) { Object.assign(state, before); throw error; }
  } } };
});

import { POST as login } from "../src/app/api/auth/login/route";
import { credentialVersionFor } from "../src/lib/session-credentials";
import { hashToken } from "../src/lib/password";

const request = (token = "valid-offer") => new Request("https://gateway.test/api/auth/login", {
  method: "POST", body: JSON.stringify({ email: "orphan@example.test", password: "fresh-password", inviteToken: token }),
});

describe("password-authenticated invitation recovery without an existing workspace", () => {
  const originalJwtSecret = process.env.GATEWAY_JWT_SECRET;

  beforeEach(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    state.user = { id: "orphan", email: "orphan@example.test", passwordHash: "verified-password", emailVerifiedAt: new Date() };
    state.identity = { userId: "orphan", email: "orphan@example.test", credentialVersion: credentialVersionFor("orphan", "verified-password"), memberships: [], multipleTenants: false };
    state.invite = { id: "offer", tenantId: "invited", email: "orphan@example.test", role: "admin", tokenHash: await hashToken("valid-offer"), expiresAt: Date.now() + 60_000 };
    state.lifecycle = "active"; state.member = false; state.accepted = false; state.issueFailure = false;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.GATEWAY_JWT_SECRET;
    else process.env.GATEWAY_JWT_SECRET = originalJwtSecret;
  });

  it("joins only the offered tenant and establishes its session after fresh password authentication", async () => {
    const res = await login(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId: "invited", role: "admin", invitationAccepted: true });
    expect(state.member).toBe(true);
    expect(state.accepted).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("cust_session=");
  });
  it("does not join on an invitation alone when the password is rejected", async () => {
    state.identity = null;
    expect((await login(request())).status).toBe(401);
    expect(state.member).toBe(false);
  });
  it.each(["wrong-email", "expired", "revoked", "suspended", "password-reset"])("fails closed for %s", async failure => {
    if (failure === "wrong-email") state.invite.email = "someone-else@example.test";
    if (failure === "expired") state.invite.expiresAt = Date.now() - 1;
    if (failure === "revoked") state.invite.revokedAt = new Date();
    if (failure === "suspended") state.lifecycle = "suspended";
    if (failure === "password-reset") state.user.passwordHash = "changed-password";
    expect((await login(request())).status).toBe(failure === "password-reset" ? 401 : 409);
    expect(state.member).toBe(false);
    expect(state.accepted).toBe(false);
  });
  it("rolls back invitation consumption and membership when session persistence fails", async () => {
    state.issueFailure = true;
    expect((await login(request())).status).toBe(503);
    expect(state.member).toBe(false);
    expect(state.accepted).toBe(false);
  });
});
