import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Only persistence, limiter and audit delivery are simulated. The public
// verify/reset/login routes, native password KDF and session mint execute.
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  user: {} as Row, memberships: [] as Row[], tenants: [] as Row[],
  proofs: [] as Row[], resets: [] as Row[], sessions: [] as Row[], statements: [] as string[],
}));
const dialect = new PgDialect();
const compile = (query: SQL) => dialect.sqlToQuery(query);
const query = {
  users: { findFirst: async () => ({ ...state.user }) },
  tenants: { findFirst: async () => state.tenants[0] },
  tenantUsers: { findFirst: async () => state.memberships[0] },
  emailVerificationTokens: { findFirst: async ({ where }: { where: SQL }) => state.proofs.find(row => row.tokenHash === compile(where).params[0] && !row.consumedAt && row.expiresAt > new Date()) },
  passwordResetTokens: { findFirst: async ({ where }: { where: SQL }) => state.resets.find(row => row.tokenHash === compile(where).params[0] && !row.consumedAt && row.expiresAt > new Date()) },
};
const tx = {
  query,
  execute: async (query: SQL) => {
    const compiled = compile(query);
    state.statements.push(compiled.sql);
    if (/UPDATE refresh_tokens/i.test(compiled.sql)) {
      state.sessions.forEach(row => { row.revokedAt = new Date(); });
      return { rows: [] };
    }
    if (/FROM tenants/i.test(compiled.sql)) return { rows: state.tenants };
    if (/FROM users/i.test(compiled.sql)) return { rows: [{ ...state.user }] };
    if (/UPDATE (?:manager|platform)_sessions/i.test(compiled.sql)) return { rows: [] };
    if (/EXTRACT\(EPOCH FROM clock_timestamp\(\)\)/i.test(compiled.sql)) return { rows: [{ now_ms: Date.now(), now_sec: Math.floor(Date.now() / 1000) }] };
    throw Error(`Unexpected setup SQL: ${compiled.sql}`);
  },
  update: (table: Parameters<typeof getTableName>[0]) => ({ set: (values: Row) => ({ where: (predicate: SQL) => {
    const name = getTableName(table);
    const params = compile(predicate).params;
    let selected: Row[] = [];
    if (name === "users") selected = [state.user];
    else if (name === "manager_sessions" || name === "platform_sessions") selected = [];
    else if (name === "email_verification_tokens") selected = state.proofs.filter(row => row.id === params[0] && !row.consumedAt && row.expiresAt > new Date());
    else if (name === "password_reset_tokens") selected = state.resets.filter(row => (row.id === params[0] || row.userId === params[0]) && !row.consumedAt && row.expiresAt > new Date());
    else throw Error(`Unexpected setup update: ${name}`);
    for (const row of selected) {
      for (const [key, value] of Object.entries(values)) row[key] = typeof value === "object" && value !== null && !(value instanceof Date) ? new Date() : value;
    }
    const promise = Promise.resolve(selected.map(row => ({ id: row.id })));
    return Object.assign(promise, { returning: async () => selected.map(row => ({ id: row.id })) });
  } }) }),
  insert: (table: Parameters<typeof getTableName>[0]) => ({ values: async (values: Row) => {
    const name = getTableName(table);
    if (name === "tenants") state.tenants.push({ ...values, lifecycle: "active" });
    else if (name === "tenant_users") state.memberships.push({ ...values });
    else if (name === "password_reset_tokens") state.resets.push({ ...values, consumedAt: null, expiresAt: new Date(Date.now() + 1_200_000) });
    else if (name === "refresh_tokens") state.sessions.push({ ...values, revokedAt: null });
    else throw Error(`Unexpected setup insert: ${name}`);
  } }),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => state.memberships }) }) }),
};
vi.mock("../src/db", () => ({ db: {
  get query() { return query; },
  transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
} }));
vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "198.51.100.24",
  reserveAuthAttempt: async () => ({ allowed: true }),
  recordAuthSuccess: async () => {}, setRateLimitHeaders: (response: Response) => response,
}));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));

import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from "../src/lib/password";
import { POST as verifyEmail } from "../src/app/api/auth/verify-email/route";
import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";
import { POST as login } from "../src/app/api/auth/login/route";

const post = (path: string, body: Row) => new Request(`https://gateway.test/api/auth/${path}`, { method: "POST", body: JSON.stringify(body) });

describe("mailbox-owner password setup production routes", () => {
  beforeEach(async () => {
    process.env.GATEWAY_JWT_SECRET = "mailbox-owner-setup-test-secret-at-least-32-characters";
    state.user = { id: "user_setup", email: "owner@example.test", passwordHash: await hashPassword("preregistrant_password_123"), emailVerifiedAt: null };
    for (const rows of [state.memberships, state.tenants, state.proofs, state.resets, state.sessions, state.statements]) rows.length = 0;
  });

  async function issueProof() {
    const proof = generateOpaqueToken();
    state.proofs.push({ id: "proof_setup", userId: state.user.id, tokenHash: await hashToken(proof), consumedAt: null, expiresAt: new Date(Date.now() + 600_000) });
    return proof;
  }

  it("cannot activate the preregistrant password or mint a session until the mailbox owner sets a new password", async () => {
    const proof = await issueProof();
    state.resets.push({ id: "older_reset", userId: state.user.id, tokenHash: await hashToken("old_reset"), consumedAt: null, expiresAt: new Date(Date.now() + 600_000) });
    const response = await verifyEmail(post("verify-email", { token: proof }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.requiresPasswordSetup).toBe(true);
    expect(state.user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await verifyPassword("preregistrant_password_123", state.user.passwordHash)).toBe(false);
    expect(state.resets[0].consumedAt).toBeInstanceOf(Date);
    expect(state.sessions).toHaveLength(0);
    const tenantId = state.memberships[0].tenantId;
    expect((await login(post("login", { email: state.user.email, password: "preregistrant_password_123", tenantId }))).status).toBe(401);
    const destination = new URL(result.next, "https://gateway.test");
    expect(destination.pathname).toBe("/reset-password");
    expect(destination.searchParams.get("setup")).toBe("1");
    const token = destination.searchParams.get("token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.resets[1].tokenHash).toBe(await hashToken(token!));
    state.statements.length = 0;
    const saved = await resetPassword(post("reset-password", { token, password: "mailbox_owner_password_456" }));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("set-cookie")).toBeNull();
    expect(state.statements[0]).toMatch(/FROM tenants.*FOR SHARE/s);
    expect(state.statements[1]).toMatch(/FROM users.*FOR UPDATE/s);
    expect(state.sessions).toHaveLength(0);
    const signedIn = await login(post("login", { email: state.user.email, password: "mailbox_owner_password_456", tenantId }));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain("cust_session=");
    expect(state.sessions).toHaveLength(1);
    expect((await resetPassword(post("reset-password", { token, password: "second_owner_password_789" }))).status).toBe(400);
    expect((await verifyEmail(post("verify-email", { token: proof }))).status).toBe(400);
  });

  it("preserves an already verified password and issues no setup token or session for a redundant email proof", async () => {
    state.user.emailVerifiedAt = new Date();
    const passwordHash = state.user.passwordHash;
    const proof = await issueProof();
    const response = await verifyEmail(post("verify-email", { token: proof }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, next: "/login", requiresPasswordSetup: false });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(state.user.passwordHash).toBe(passwordHash);
    expect(state.proofs[0].consumedAt).toBeInstanceOf(Date);
    expect(state.resets).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
  });

  it("locks the existing audit tenant before the user while retaining suspended-workspace recovery", async () => {
    state.tenants.push({ id: "tenant_suspended", lifecycle: "suspended" });
    state.memberships.push({ userId: state.user.id, tenantId: "tenant_suspended", role: "viewer" });
    const proof = await issueProof();
    const response = await verifyEmail(post("verify-email", { token: proof }));
    expect(response.status).toBe(200);
    expect(state.statements[0]).toMatch(/FROM tenants.*FOR SHARE/s);
    expect(state.statements[1]).toMatch(/FROM users.*FOR UPDATE/s);
    const token = new URL((await response.json()).next, "https://gateway.test").searchParams.get("token");
    const saved = await resetPassword(post("reset-password", { token, password: "recovered_owner_password_123" }));
    expect(saved.status).toBe(200);
    expect(await verifyPassword("recovered_owner_password_123", state.user.passwordHash)).toBe(true);
    expect(state.tenants[0].lifecycle).toBe("suspended");
    expect(state.memberships[0].role).toBe("viewer");
  });
});
