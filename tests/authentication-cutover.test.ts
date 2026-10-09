import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Database/external boundaries only are simulated. Authentication, password
// hashing, password-reset handler, JWT issuance/verification, workspace
// selection handler and session validation execute their production code.
const state = vi.hoisted(() => ({ user: {} as Record<string, any>, sessions: [] as Array<Record<string, any>>, consumedSelections: new Set<string>(), revokeAtTransaction: false }));
const dialect = new PgDialect();
const clock = () => ({ rows: [{ now_ms: Date.now(), now_sec: Math.floor(Date.now() / 1000) }] });
const execute = async (query: any) => {
  const compiled = dialect.sqlToQuery(query);
  if (/UPDATE refresh_tokens/i.test(compiled.sql)) {
    for (const row of state.sessions) row.revokedAt = new Date();
    return { rows: [] };
  }
  if (/SELECT id FROM refresh_tokens/i.test(compiled.sql)) return { rows: state.sessions.filter(row => !row.revokedAt) };
  if (/FROM users/i.test(compiled.sql)) return { rows: [{ ...state.user }] };
  return clock();
};
const query = {
  users: { findFirst: async () => ({ ...state.user }) },
  tenants: { findFirst: async () => ({ id: "tenant_repro", lifecycle: "active" }) },
  tenantUsers: { findFirst: async () => ({ userId: state.user.id, tenantId: "tenant_repro", role: "admin" }) },
  passwordResetTokens: { findFirst: async () => ({ id: "reset_repro", userId: state.user.id, expiresAt: new Date(Date.now() + 100_000), consumedAt: null }) },
  refreshTokens: { findFirst: async () => state.sessions.find(row => !row.revokedAt) ?? null },
};
const tx = {
  execute,
  query,
  update: (table: any) => ({ set: (values: any) => ({ where: () => {
    const name = getTableName(table);
    if (name === "users") Object.assign(state.user, values);
    const rows = name === "users" ? [{ id: state.user.id }] : name === "password_reset_tokens" ? [{ id: "reset_repro" }] : [];
    const promise: any = Promise.resolve(rows);
    promise.returning = async () => rows;
    return promise;
  } }) }),
  insert: (table: any) => ({ values: (values: any) => {
    const name = getTableName(table);
    if (name === "refresh_tokens") state.sessions.push({ ...values, revokedAt: null });
    const promise: any = Promise.resolve();
    promise.onConflictDoNothing = () => ({ returning: async () => {
      if (state.consumedSelections.has(values.key)) return [];
      state.consumedSelections.add(values.key);
      return [{ key: values.key }];
    } });
    return promise;
  } }),
};
vi.mock("../src/db", () => ({ db: {
  get query() { return tx.query; },
  execute: (query: any) => tx.execute(query),
  update: (table: any) => tx.update(table),
  insert: (table: any) => tx.insert(table),
  transaction: async (fn: any) => {
    if (state.revokeAtTransaction) { state.revokeAtTransaction = false; for (const row of state.sessions) row.revokedAt = new Date(); }
    return fn(tx);
  },
} }));
vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "198.51.100.10", reserveAuthAttempt: async () => ({ allowed: true, limit: 5, remaining: 4, resetAtEpochSec: 9999999999 }),
  recordAuthSuccess: async () => {}, setRateLimitHeaders: (response: Response) => response,
}));
vi.mock("../src/lib/email", () => ({ sendTransactionalEmail: async () => {} }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));

import { authenticateManagerUser } from "../src/lib/manager-auth";
import { authenticatePlatformOwner } from "../src/lib/platform-auth";
import { AuthenticationChangedError, credentialVersionFor, issueSessionPair } from "../src/lib/session-tokens";
import { hashPassword } from "../src/lib/password";
import { authenticateForTenant, createTenantSelectionToken, verifyTenantSelectionToken } from "../src/lib/customer-auth";
import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";
import { POST as selectTenant } from "../src/app/api/auth/select-tenant/route";

describe("credential snapshots across password-reset cutover", () => {
  beforeEach(async () => {
    process.env.GATEWAY_JWT_SECRET = "audit-only-test-secret-with-at-least-32-characters";
    state.user = { id: "user_repro", email: "audit@example.test", emailVerifiedAt: new Date(), isPlatformOwner: true, passwordHash: await hashPassword("previous_password_123") };
    state.sessions.length = 0;
    state.consumedSelections.clear();
    state.revokeAtTransaction = false;
  });

  async function reset() {
    const result = await resetPassword(new Request("http://gateway.test/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token: "synthetic_reset_token", password: "replacement_password_456" }) }));
    expect(result.status).toBe(200);
  }

  it.each(["customer", "manager", "platform"] as const)("rejects %s login verified before password reset commits", async (kind) => {
    const identity = kind === "customer"
      ? await authenticateForTenant("audit@example.test", "previous_password_123", "tenant_repro")
      : kind === "manager"
        ? await authenticateManagerUser("audit@example.test", "previous_password_123", "tenant_repro")
        : await authenticatePlatformOwner("audit@example.test", "previous_password_123");
    expect(identity).not.toBeNull();
    await reset();
    await expect(issueSessionPair({
      kind, userId: identity!.userId, email: "audit@example.test",
      ...(kind === "platform" ? {} : { tenantId: "tenant_repro", role: "admin" }),
      credentialVersion: identity!.credentialVersion,
    })).rejects.toBeInstanceOf(AuthenticationChangedError);
    expect(state.sessions).toHaveLength(0);
  });

  it.each(["customer", "manager", "platform"] as const)("issues %s session while verified credentials are unchanged, without leaking proof", async (kind) => {
    const pair = await issueSessionPair({
      kind, userId: "user_repro", email: "audit@example.test",
      ...(kind === "platform" ? {} : { tenantId: "tenant_repro", role: "admin" }),
      credentialVersion: credentialVersionFor("user_repro", String(state.user.passwordHash)),
    });
    expect(state.sessions).toHaveLength(1);
    const claims = JSON.parse(Buffer.from(pair.accessToken.split(".")[1], "base64url").toString());
    expect(claims).not.toHaveProperty("credentialVersion");
    expect(JSON.stringify(claims)).not.toContain(state.user.passwordHash);
    await reset();
    expect(state.sessions.filter(row => !row.revokedAt)).toHaveLength(0);
  });

  it("rejects a source session revoked after selection preflight", async () => {
    const source = await issueSessionPair({ kind: "customer", userId: "user_repro", tenantId: "tenant_repro", role: "admin", email: "audit@example.test" });
    state.revokeAtTransaction = true;
    const response = await selectTenant(new Request("http://gateway.test/api/auth/select-tenant", {
      method: "POST", headers: { cookie: "cust_session=" + source.accessToken },
      body: JSON.stringify({ tenantId: "tenant_repro" }),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(state.sessions.filter(row => !row.revokedAt)).toHaveLength(0);
  });

  it("rejects a pre-reset workspace-selection token at consumption after reset", async () => {
    const token = await createTenantSelectionToken("user_repro", "audit@example.test", credentialVersionFor("user_repro", String(state.user.passwordHash)));
    await reset();
    expect(await verifyTenantSelectionToken(token)).not.toBeNull();
    const response = await selectTenant(new Request("http://gateway.test/api/auth/select-tenant", { method: "POST", body: JSON.stringify({ tenantId: "tenant_repro", selectionToken: token }) }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(state.sessions).toHaveLength(0);
  });
});
