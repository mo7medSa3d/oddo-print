import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { lockDurationMs, accountKey, ipKey, clientIpFrom, cleanupAuthRateLimits, AUTH_RATE_RETENTION_MS } from "../src/lib/auth-rate-limit";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  pool,
} from "./helpers/pg";
import { POST as loginPOST } from "../src/app/api/auth/manager/login/route";
import { hashPassword } from "../src/lib/password";

describe("auth rate limiter (pure)", () => {
  it("has no lock below 5 failures", () => {
    expect(lockDurationMs(0)).toBe(0);
    expect(lockDurationMs(4)).toBe(0);
  });

  it("progresses 30s → 5min → 15min → 60min", () => {
    expect(lockDurationMs(5)).toBe(30_000);
    expect(lockDurationMs(9)).toBe(30_000);
    expect(lockDurationMs(10)).toBe(5 * 60_000);
    expect(lockDurationMs(15)).toBe(15 * 60_000);
    expect(lockDurationMs(20)).toBe(60 * 60_000);
  });

  it("normalizes account and IP keys", () => {
    expect(accountKey("  Admin ")).toBe("acct:admin");
    expect(ipKey("10.0.0.1")).toBe("ip:10.0.0.1");
  });

  it("ignores forwarding headers unless TRUST_PROXY is explicitly enabled", () => {
    const req = new Request("http://gw/login", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "10.0.0.1" },
    });
    const prev = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    expect(clientIpFrom(req)).toBe("unknown");
    process.env.TRUST_PROXY = "1";
    expect(clientIpFrom(req)).toBe("203.0.113.9");
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  });

  it("rejects malformed forwarded addresses", () => {
    const req = new Request("http://gw/login", {
      headers: { "x-forwarded-for": "not-an-ip", "x-real-ip": "also-not-an-ip" },
    });
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "1";
    expect(clientIpFrom(req)).toBe("unknown");
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  });
});

describe("atomic rate-limit reservation contract", () => {
  it("uses atomic reservation for all public authentication entrypoints", async () => {
    const { readFile } = await import("node:fs/promises");
    const authFiles = [
      "src/app/api/auth/login/route.ts",
      "src/app/api/auth/manager/login/route.ts",
      "src/app/api/auth/register/route.ts",
      "src/app/api/auth/forgot-password/route.ts",
    ];
    for (const file of authFiles) {
      const source = await readFile(file, "utf8");
      expect(source).toContain("reserveAuthAttempt");
    }
    // Agent pairing has its own brute-force budget independent of the
    // account/user limiter, so it reserves from the pairing bucket only.
    const pairingSource = await readFile("src/app/api/agent/register/route.ts", "utf8");
    expect(pairingSource).toContain("reservePairingAttempt");
    expect(pairingSource).not.toContain("reserveAuthAttempt");
    const authRateSource = await readFile("src/lib/auth-rate-limit.ts", "utf8");
    expect(authRateSource).toContain("FOR UPDATE");
    expect(authRateSource).toContain("ON CONFLICT (key) DO NOTHING");
    const wsRateSource = await readFile("src/lib/ws-rate-limit.ts", "utf8");
    const wsServerSource = await readFile("src/server/ws.ts", "utf8");
    expect(wsRateSource).toContain("reserveWsUpgradeAttempt");
    expect(wsRateSource).toContain("FOR UPDATE");
    expect(wsServerSource).toContain("reserveWsUpgradeAttempt");
    expect(wsServerSource).not.toContain("recordWsUpgradeFailure");
  });
});

const suite = describe.skipIf(!hasTestDatabase);

suite("manager login rate limiting", () => {
  const USER = "rate-limit-admin";
  const PASS = "correct-horse-battery";

  beforeAll(async () => {
    await applyMigrations();
    process.env.MANAGER_USERNAME = USER;
    process.env.MANAGER_PASSWORD = PASS;
    // Plaintext credentials are explicitly opt-in in production code. This
    // integration suite uses the simple password fixture, so opt in only for
    // the duration of this test suite rather than weakening the production
    // default.
    process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD = "1";
    process.env.ALLOW_LEGACY_MANAGER_AUTH = "1";
    process.env.GATEWAY_JWT_SECRET = process.env.GATEWAY_JWT_SECRET || "x".repeat(32);
    process.env.TRUST_PROXY = "1";
    process.env.MANAGER_TENANT_ID = "tenant_rate_limit_test";
  });

  afterAll(async () => {
    delete process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD;
    delete process.env.ALLOW_LEGACY_MANAGER_AUTH;
    delete process.env.MANAGER_TENANT_ID;
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    await pool().query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, ["tenant_rate_limit_test", "Rate Limit Test Tenant"]);
  });

  function login(username: string, password: string, ip = "198.51.100.10", host = "gateway.test") {
    return loginPOST(new Request(`http://${host}/api/auth/manager/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip, host },
      body: JSON.stringify({ username, password }),
    }));
  }

  it("legacy credentials mint an owner session for the exact configured tenant", async () => {
    const res = await login(USER, PASS);
    expect(res.status).toBe(200);
    const session = await pool().query(`SELECT tenant_id, user_id, role FROM manager_sessions`);
    expect(session.rows).toEqual([{ tenant_id: "tenant_rate_limit_test", user_id: null, role: "owner" }]);
  });

  it("legacy credentials cannot mint a session for a hostname-resolved different tenant", async () => {
    await pool().query(`INSERT INTO tenants (id, name) VALUES ('tenant_b', 'Tenant B')`);
    await pool().query(`INSERT INTO tenant_domains (id, tenant_id, domain, verified_at) VALUES ('domain_b', 'tenant_b', 'tenant-b.test', now())`);

    const res = await login(USER, PASS, "198.51.100.12", "tenant-b.test");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await pool().query(`SELECT count(*)::int AS count FROM manager_sessions`)).rows[0].count).toBe(0);
  });

  it("normal tenant identity login remains available on a different tenant hostname", async () => {
    const email = "manager-b@example.test";
    const password = "tenant-b-password";
    await pool().query(`INSERT INTO tenants (id, name) VALUES ('tenant_b', 'Tenant B')`);
    await pool().query(`INSERT INTO tenant_domains (id, tenant_id, domain, verified_at) VALUES ('domain_b', 'tenant_b', 'tenant-b.test', now())`);
    await pool().query(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ('user_b', $1, $2, now())`, [email, await hashPassword(password)]);
    await pool().query(`INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ('user_b', 'tenant_b', 'admin')`);

    const res = await login(email, password, "198.51.100.13", "tenant-b.test");
    expect(res.status).toBe(200);
    const session = await pool().query(`SELECT tenant_id, user_id, role FROM manager_sessions`);
    expect(session.rows).toEqual([{ tenant_id: "tenant_b", user_id: "user_b", role: "admin" }]);
  });

  it("repeated failures then 429 with Retry-After", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await login(USER, "wrong");
      expect(res.status).toBe(401);
    }
    const fifth = await login(USER, "wrong");
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("Retry-After")).not.toBeNull();
    const body = await fifth.json();
    expect(body.error).toMatch(/too many/i);
  });

  it("does not enumerate users", async () => {
    const known = await login(USER, "wrong");
    const unknown = await login("no-such-user", "wrong", "198.51.100.11");
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await known.json()).error).toBe((await unknown.json()).error);
  });

  it("the account bucket still locks new source IPs (lockout is account-scoped too)", async () => {
    for (let i = 0; i < 5; i++) {
      await login(USER, "wrong", "203.0.113.1");
    }
    const other = await login(USER, PASS, "203.0.113.2");
    expect(other.status).toBe(429);
  });

  it("different accounts are tracked separately", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login("attacker", "wrong", "198.51.100.50");
      expect([401, 429]).toContain(res.status);
    }
    const ok = await login(USER, PASS, "198.51.100.51");
    expect(ok.status).toBe(200);
  });

  it("successful login after cooldown recovers the account", async () => {
    for (let i = 0; i < 5; i++) {
      await login(USER, "wrong", "198.51.100.70");
    }
    await pool().query(`UPDATE auth_rate_limits SET locked_until = now() - interval '1 second'`);
    const ok = await login(USER, PASS, "198.51.100.70");
    expect(ok.status).toBe(200);
    const after = await login(USER, "wrong", "198.51.100.71");
    expect(after.status).toBe(401);
  });

  it("removes only expired buckets and retains recent security state", async () => {
    const staleAt = new Date(Date.now() - AUTH_RATE_RETENTION_MS - 60_000);
    await pool().query(`INSERT INTO auth_rate_limits (key, failures, window_started_at, updated_at) VALUES ($1, 1, now() - interval '2 days', $2) ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at`, ["ip:stale", staleAt]);
    await pool().query(`INSERT INTO auth_rate_limits (key, failures, window_started_at, updated_at) VALUES ($1, 1, now(), now()) ON CONFLICT (key) DO UPDATE SET updated_at = now()`, ["ip:fresh"]);
    const removed = await cleanupAuthRateLimits();
    expect(removed).toBeGreaterThanOrEqual(1);
    const rows = await pool().query(`SELECT key FROM auth_rate_limits WHERE key IN ('ip:stale','ip:fresh') ORDER BY key`);
    expect(rows.rows.map((r) => r.key)).toEqual(["ip:fresh"]);
  });

  it("concurrent attempts cannot bypass the limiter", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => login(USER, "wrong", "198.51.100.80"))
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.some((s) => s === 401 || s === 429)).toBe(true);
    const failures = await pool().query(
      `SELECT failures FROM auth_rate_limits WHERE key = $1`,
      ["acct:rate-limit-admin"]
    );
    expect(Number(failures.rows[0]?.failures ?? 0)).toBeGreaterThanOrEqual(5);
  });
});
