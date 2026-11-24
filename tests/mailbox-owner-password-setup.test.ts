import type * as PasswordScreeningModule from "../src/lib/password-screening";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayTestSigningKey } from "./helpers/test-secrets";

// External breach-corpus fixture for these unrelated account/transaction tests.
// Production always screens; password-screening*.test.ts exercise the real
// range protocol, positive matches, privacy, limits and fail-closed behavior.
vi.mock("../src/lib/password-screening", async (importActual) => ({
  ...await importActual<typeof PasswordScreeningModule>(),
  screenNewPassword: vi.fn(async () => "acceptable"),
}));
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Only persistence, limiter and audit delivery are simulated. The public
// verify/reset/login routes, native password KDF and session mint execute.
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  user: {} as Row, memberships: [] as Row[], tenants: [] as Row[],
  proofs: [] as Row[], resets: [] as Row[], sessions: [] as Row[], policies: [] as Row[], statements: [] as string[],
}));
const dialect = new PgDialect();
const compile = (query: SQL) => dialect.sqlToQuery(query);
const query = {
  users: { findFirst: async () => ({ ...state.user }) },
  tenants: { findFirst: async () => state.tenants[0] },
  // v3 WP3 B2-03: reset-password mints the setup session only when exactly
  // one membership exists, via findMany (not the old single findFirst).
  tenantUsers: { findFirst: async () => state.memberships[0], findMany: async () => state.memberships },
  emailVerificationTokens: { findFirst: async ({ where }: { where: SQL }) => state.proofs.find(row => row.tokenHash === compile(where).params[0] && !row.consumedAt && row.expiresAt > new Date()) },
  passwordResetTokens: { findFirst: async ({ where }: { where: SQL }) => state.resets.find(row => row.tokenHash === compile(where).params[0] && !row.consumedAt && row.expiresAt > new Date()) },
};
const tx = {
  query,
  execute: async (query: SQL) => {
    const compiled = compile(query);
    state.statements.push(compiled.sql);
    if (/SELECT role FROM tenant_users/.test(compiled.sql)) return { rows: state.memberships.filter(row => row.userId === compiled.params[0] && row.tenantId === compiled.params[1]) };
    if (/INSERT INTO workspace_session_security/.test(compiled.sql)) {
      const [familyId,kind,tenantId,userId,credentialVersion] = compiled.params;
      state.policies.push({ familyId,kind,tenantId,userId,credentialVersion });
      return { rows: [] };
    }
    if (/UPDATE refresh_tokens/i.test(compiled.sql)) {
      state.sessions.forEach(row => { row.revokedAt = new Date(); });
      return { rows: [] };
    }
    if (/FROM tenants/i.test(compiled.sql)) return { rows: state.tenants };
    if (/FROM users/i.test(compiled.sql)) return { rows: [{ ...state.user, password_hash: state.user.passwordHash, email_verified_at: state.user.emailVerifiedAt }] };
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
  insert: (table: Parameters<typeof getTableName>[0]) => ({ values: async (values: Row | Row[]) => {
    const name = getTableName(table);
    if (Array.isArray(values)) throw Error("Unexpected bulk fixture insert");
    if (name === "tenants") state.tenants.push({ ...values, lifecycle: "active" });
    else if (name === "tenant_users") state.memberships.push({ ...values });
    else if (name === "password_reset_tokens") state.resets.push({ ...values, consumedAt: null, expiresAt: new Date(Date.now() + 600_000) });
    else if (name === "refresh_tokens") state.sessions.push({ ...values, revokedAt: null });
    else throw Error(`Unexpected setup insert: ${name}`);
  } }),
  select: () => ({ from: () => ({ where: () => {
    const rows = state.memberships;
    const snapshot = rows.map(row => ({ ...row }));
    return Object.assign(Promise.resolve(snapshot), { for: async () => snapshot, limit: async () => snapshot });
  } }) }),
};
vi.mock("../src/db", () => ({ db: {
  get query() { return query; },
  execute: (query: SQL) => tx.execute(query),
  update: (table: Parameters<typeof getTableName>[0]) => tx.update(table),
  transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
} }));
vi.mock("../src/lib/auth-rate-limit", () => ({
  clientIpFrom: () => "198.51.100.24",
  reserveAuthAttempt: async () => ({ allowed: true }),
  recordAuthSuccess: async () => {}, refundAuthReservation: async () => {}, setRateLimitHeaders: (response: Response) => response,
}));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));

import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from "../src/lib/password";
import { POST as verifyEmail } from "../src/app/api/auth/verify-email/route";
import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";
import { POST as login } from "../src/app/api/auth/login/route";

const post = (path: string, body: Row) => new Request(`https://gateway.test/api/auth/${path}`, { method: "POST", headers: { origin: "https://gateway.test" }, body: JSON.stringify(body) });

describe("mailbox-owner password setup production routes", () => {
  const originalJwtSecret = process.env.GATEWAY_JWT_SECRET;
  const originalAppBaseUrl = process.env.APP_BASE_URL;

  beforeEach(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    process.env.APP_BASE_URL = "https://gateway.test";
    state.user = { id: "user_setup", email: "owner@example.test", passwordHash: await hashPassword("preregistrant_password_123"), emailVerifiedAt: null };
    for (const rows of [state.memberships, state.tenants, state.proofs, state.resets, state.sessions, state.policies, state.statements]) rows.length = 0;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.GATEWAY_JWT_SECRET;
    else process.env.GATEWAY_JWT_SECRET = originalJwtSecret;
    if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalAppBaseUrl;
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
    expect(state.resets[1].id).toMatch(/^psu_/);
    state.statements.length = 0;
    const saved = await resetPassword(post("reset-password", { token, password: "mailbox_owner_password_456" }));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("set-cookie")).toContain("cust_session=");
    await expect(saved.json()).resolves.toMatchObject({ ok: true, authenticated: true });
    expect(state.statements[0]).toMatch(/FROM tenants.*FOR SHARE/s);
    expect(state.statements[1]).toMatch(/FROM users.*FOR UPDATE/s);
    expect(state.sessions).toHaveLength(1);
    const loginRequest = post("login", { email: state.user.email, password: "mailbox_owner_password_456", tenantId });
    const signedIn = await login(loginRequest);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain("cust_session=");
    expect(state.sessions).toHaveLength(2);
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
    expect(saved.headers.get("set-cookie")).toBeNull(); // suspended workspaces cannot receive sessions
  });
  it("an ordinary recovery proof never auto-authenticates even with a setup query", async () => {
    state.user.emailVerifiedAt = new Date();
    state.tenants.push({ id: "tenant_active", lifecycle: "active" });
    state.memberships.push({ userId: state.user.id, tenantId: "tenant_active", role: "owner" });
    const token = generateOpaqueToken();
    state.resets.push({ id: "prt_recovery", userId: state.user.id, tokenHash: await hashToken(token), consumedAt: null, expiresAt: new Date(Date.now() + 600_000) });
    const saved = await resetPassword(post("reset-password", { token, password: "owner_recovered_password_789", setup: "1" }));
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ ok: true, authenticated: false });
    expect(saved.headers.get("set-cookie")).toBeNull();
    expect(state.sessions).toHaveLength(0);
  });


});
