import type * as PasswordScreeningModule from "../src/lib/password-screening";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// External breach-corpus fixture for these unrelated account/transaction tests.
// Production always screens; password-screening*.test.ts exercise the real
// range protocol, positive matches, privacy, limits and fail-closed behavior.
vi.mock("../src/lib/password-screening", async (importActual) => ({
  ...await importActual<typeof PasswordScreeningModule>(),
  screenNewPassword: vi.fn(async () => "acceptable"),
}));
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  existing: true,
  owner: true,
  failAt: "",
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  queries: [] as string[],
  audits: [] as Record<string, unknown>[],
}));
const dialect = new PgDialect();
const tx = {
  execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const { sql, params } = dialect.sqlToQuery(query);
    state.queries.push(sql);
    if (sql.includes("is_platform_owner = true")) return { rows: state.owner ? [{ id: "target" }] : [] };
    if (sql.includes("FROM users WHERE email")) return { rows: state.existing ? [{ id: "target" }] : [] };
    if (sql.includes("UPDATE refresh_tokens")) {
      for (const row of state.rows.refresh_tokens) {
        if (row.userId === params[1] && !row.revokedAt) row.revokedAt = new Date();
      }
    }
    return { rows: [] };
  },
  update: (table: Parameters<typeof getTableName>[0]) => ({ set: (values: Record<string, unknown>) => ({
    where: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const name = getTableName(table);
      if (state.failAt === name) throw new Error("synthetic transaction failure");
      const { sql, params } = dialect.sqlToQuery(query);
      state.queries.push(sql);
      for (const row of state.rows[name]) {
        const identity = name === "users" ? row.id : row.userId;
        const consumed = sql.includes('"consumed_at" is null') && row.consumedAt;
        if (identity === params[0] && !consumed) Object.assign(row, values);
      }
    },
  }) }),
  insert: (table: Parameters<typeof getTableName>[0]) => ({ values: async (values: Record<string, unknown>) => {
    if (getTableName(table) === "audit_events") state.audits.push(values);
    else state.rows.users.push(values);
  } }),
};
vi.mock("../src/db", () => ({ pool: { end: vi.fn() }, db: {
  transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(state.rows);
    try { return await operation(tx); }
    catch (error) { state.rows = snapshot; throw error; }
  },
} }));

import { main as bootstrap } from "../scripts/bootstrap-platform-owner";
import { verifyPassword } from "../src/lib/password";

describe("Platform Owner bootstrap credential cutover", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.stubEnv("PLATFORM_OWNER_EMAIL", "owner@example.test");
    vi.stubEnv("PLATFORM_OWNER_PASSWORD", "replacement_password_123");
    vi.stubEnv("ALLOW_PLATFORM_BOOTSTRAP_FORCE", "1");
    vi.stubEnv("PLATFORM_OWNER_PASSWORD_FILE", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    state.existing = true;
    state.owner = true;
    state.failAt = "";
    state.queries = [];
    state.audits = [];
    state.rows = {
      users: [{ id: "target", passwordHash: "previous", isPlatformOwner: false }, { id: "other", passwordHash: "other" }],
      manager_sessions: [{ userId: "target", revokedAt: null }, { userId: "other", revokedAt: null }],
      platform_sessions: [{ userId: "target", revokedAt: null }, { userId: "other", revokedAt: null }],
      refresh_tokens: [{ userId: "target", kind: "customer", revokedAt: null }, { userId: "target", kind: "manager", revokedAt: null }, { userId: "target", kind: "platform", revokedAt: null }, { userId: "other", revokedAt: null }],
      password_reset_tokens: [{ userId: "target", consumedAt: null }, { userId: "other", consumedAt: null }, { userId: "target", consumedAt: "already-consumed" }],
      email_verification_tokens: [{ userId: "target", consumedAt: null }, { userId: "other", consumedAt: null }],
    };
  });

  it.each([true, false])("closes existing credentials on forced reset or first promotion (owner=%s)", async (owner) => {
    state.owner = owner;
    state.rows.users[0].isPlatformOwner = owner;
    if (!owner) vi.stubEnv("ALLOW_PLATFORM_BOOTSTRAP_FORCE", "0");
    await bootstrap();
    expect(state.rows.users[0]).toMatchObject({ isPlatformOwner: true });
    expect(state.rows.users[0].passwordHash).not.toBe("previous");
    for (const name of ["manager_sessions", "platform_sessions", "refresh_tokens"]) {
      expect(state.rows[name].filter(row => row.userId === "target").every(row => row.revokedAt)).toBe(true);
      expect(state.rows[name].find(row => row.userId === "other")?.revokedAt).toBeNull();
    }
    for (const name of ["password_reset_tokens", "email_verification_tokens"]) {
      expect(state.rows[name][0].consumedAt).toBeTruthy();
      expect(state.rows[name][1].consumedAt).toBeNull();
    }
    expect(state.rows.password_reset_tokens[2].consumedAt).toBe("already-consumed");
    expect(state.audits).toHaveLength(1);
    expect(state.queries.some(query => query.includes("FROM users WHERE email") && query.includes("FOR UPDATE"))).toBe(true);
  });

  it("leaves all credentials untouched when an owner exists and force is absent", async () => {
    vi.stubEnv("ALLOW_PLATFORM_BOOTSTRAP_FORCE", "0");
    const before = structuredClone(state.rows);
    await bootstrap();
    expect(state.rows).toEqual(before);
    expect(state.audits).toHaveLength(0);
  });

  it("preserves intentional leading and trailing password spaces during bootstrap", async () => {
    const exact = "  intentional whitespace password 456  ";
    vi.stubEnv("PLATFORM_OWNER_PASSWORD", exact);
    await bootstrap();
    const hash = String(state.rows.users[0].passwordHash);
    expect(await verifyPassword(exact, hash)).toBe(true);
    expect(await verifyPassword(exact.trim(), hash)).toBe(false);
  });

  it("rolls back password replacement when recovery-proof invalidation fails", async () => {
    state.failAt = "password_reset_tokens";
    const before = structuredClone(state.rows);
    await expect(bootstrap()).rejects.toThrow("synthetic transaction failure");
    expect(state.rows).toEqual(before);
    expect(state.audits).toHaveLength(0);
  });

  it.each(["😀".repeat(6), "Ab9!?xyZ😃🧪🔐"])("rejects a new bootstrap password with fewer than twelve code points", async (password) => {
    vi.stubEnv("PLATFORM_OWNER_PASSWORD", password);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("bootstrap rejected password"); });
    const before = structuredClone(state.rows);
    await expect(bootstrap()).rejects.toThrow("bootstrap rejected password");
    expect(state.rows).toEqual(before);
    expect(state.queries).toHaveLength(0);
  });

  it("accepts and preserves a twelve-code-point emoji bootstrap password", async () => {
    const password = "😀".repeat(12);
    vi.stubEnv("PLATFORM_OWNER_PASSWORD", password);
    await bootstrap();
    expect(await verifyPassword(password, String(state.rows.users[0].passwordHash))).toBe(true);
  });
});
