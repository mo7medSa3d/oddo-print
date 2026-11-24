import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { hashPassword } from "../src/lib/password";
import { POST as customerLogin } from "../src/app/api/auth/login/route";
import { POST as managerLogin } from "../src/app/api/auth/manager/login/route";
import { POST as platformLogin } from "../src/app/api/platform/auth/login/route";
import { GET as platformMe } from "../src/app/api/platform/auth/me/route";
import { GET as managerMe } from "../src/app/api/auth/manager/me/route";
import { POST as selectTenant } from "../src/app/api/auth/select-tenant/route";
import { validateCustomer } from "../src/lib/customer-auth";
import { validateManager } from "../src/lib/manager-auth";
import { validatePlatformOwner, requirePlatformActorInTransaction } from "../src/lib/platform-auth";
import { db } from "../src/db";
import { issueSessionPair, rotateRefreshToken } from "../src/lib/session-tokens";

const password = "V3 exact password fixture 7! ";
let passwordHash: string;
const roles = ["owner", "admin"] as const;
const origin = "http://localhost:3000";
function request(path: string, body?: unknown, cookie = "") {
  return new Request(origin + path, { method: body === undefined ? "GET" : "POST",
    headers: { origin, host: "localhost:3000", "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function cookies(response: Response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); }
function value(response: Response, name: string) { return response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(";")[0].slice(name.length+1) ?? ""; }
async function platformSession() {
  const response = await platformLogin(request("/api/platform/auth/login", { email: "user@example.test", password }));
  expect(response.status).toBe(200);
  const claims = await validatePlatformOwner(request("/api/platform/auth/me", undefined, cookies(response)));
  expect(claims).not.toBeNull();
  return { response, claims: claims! };
}

describe.skipIf(!hasTestDatabase)("password-only authentication and retained session boundaries", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = randomBytes(32).toString("base64url");
    process.env.APP_BASE_URL = origin;
    await applyMigrations();
    passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants(id,name) VALUES ('a','A'),('b','B')");
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner) VALUES ('user','user@example.test',$1,clock_timestamp(),true)", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('user','a','owner')");
    vi.stubEnv("MANAGER_TENANT_ID", "a");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(closePool);

  it("does not cache manager or Platform Owner session metadata or unauthenticated probes", async () => {
    // Both authenticated metadata and 401 probes must be uncached so logout
    // and newly signed-in sessions are never mistaken for a cached response.
    const manager = await managerLogin(request("/api/auth/manager/login", { username: "user@example.test", password }));
    const platform = await platformLogin(request("/api/platform/auth/login", { email: "user@example.test", password }));
    expect(manager.status).toBe(200);
    expect(platform.status).toBe(200);

    const probes = [
      { endpoint: managerMe, path: "/api/auth/manager/me", cookie: cookies(manager) },
      { endpoint: platformMe, path: "/api/platform/auth/me", cookie: cookies(platform) },
    ];
    for (const { endpoint, path, cookie } of probes) {
      const verified = await endpoint(request(path, undefined, cookie));
      expect(verified.status, path).toBe(200);
      expect(verified.headers.get("Cache-Control"), path).toContain("no-store");
      expect(verified.headers.get("Cache-Control"), path).toContain("private");
      expect(await verified.json()).toMatchObject({ authenticated: true, userId: "user" });

      const denied = await endpoint(request(path));
      expect(denied.status, path).toBe(401);
      expect(denied.headers.get("Cache-Control"), path).toContain("no-store");
    }
  });

  it.each(roles)("immediately admits a %s workspace user after a correct password", async role => {
    await pool().query("UPDATE tenant_users SET role=$1 WHERE user_id='user'", [role]);
    const response = await customerLogin(request("/api/auth/login", { email: "user@example.test", password }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tenantId: "a", role });
    expect(await validateCustomer(request("/api/auth/me", undefined, cookies(response)))).toMatchObject({ userId: "user", role, kind: "customer" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.getSetCookie().filter(c => /cust_(session|refresh)=/.test(c))).toHaveLength(2);
    expect(response.headers.getSetCookie().every(c => c.includes("HttpOnly"))).toBe(true);
  });

  it.each(roles)("immediately admits a %s account at the manager endpoint", async role => {
    await pool().query("UPDATE tenant_users SET role=$1 WHERE user_id='user'", [role]);
    const response = await managerLogin(request("/api/auth/manager/login", { username: "user@example.test", password }));
    expect(response.status).toBe(200);
    expect(await validateManager(request("/api/auth/manager/me", undefined, cookies(response)))).toMatchObject({ userId: "user", role, kind: "manager" });
    expect(JSON.stringify(await response.json())).not.toMatch(/accessToken|refreshToken|password|credentialVersion/);
  });

  it("immediately admits a Platform Owner with current server-side owner authority", async () => {
    const { claims, response } = await platformSession();
    expect(response.headers.getSetCookie().filter(c => /plt_(session|refresh)=/.test(c))).toHaveLength(2);
    await expect(db.transaction(tx => requirePlatformActorInTransaction(tx, claims))).resolves.toBeUndefined();
    await pool().query("UPDATE users SET is_platform_owner=false WHERE id='user'");
    expect(await validatePlatformOwner(request("/api/platform/auth/me", undefined, cookies(response)))).toBeNull();
    await expect(db.transaction(tx => requirePlatformActorInTransaction(tx, claims))).rejects.toThrow();
    expect((await rotateRefreshToken("platform", value(response, "plt_refresh"))).status).toBe("invalid");
  });

  it("commits the Platform Owner login audit before returning successful credentials", async () => {
    // A locked audit table exposes an implicit fire-and-forget insert: its
    // caller may return a successful session while the audit is still pending.
    // The test checks the actual PostgreSQL insertion, not a mocked logger.
    const blocker = await pool().connect();
    let loginPromise: Promise<Response> | null = null;
    let finished = false;
    let finishedWhileAuditBlocked = false;
    let auditWriteWaiting = false;
    await blocker.query("BEGIN");
    try {
      await blocker.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
      loginPromise = platformLogin(request("/api/platform/auth/login", { email: "user@example.test", password }))
        .then(response => { finished = true; return response; });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const active = await pool().query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND query ILIKE '%audit_events%' LIMIT 1`);
        if (active.rows.length) { auditWriteWaiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Give the login response microtasks time to settle while the actual
      // audit INSERT remains blocked by our independent PostgreSQL lock.
      if (auditWriteWaiting) await new Promise(resolve => setTimeout(resolve, 100));
      finishedWhileAuditBlocked = finished;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const response = await loginPromise;
    expect(auditWriteWaiting).toBe(true);
    expect(finishedWhileAuditBlocked).toBe(false);
    expect(response.status).toBe(200);
    const audits = await pool().query("SELECT id FROM audit_events WHERE actor_id='user' AND action='platform.login'");
    expect(audits.rows).toHaveLength(1);
  });

  it("never lets an unverified account, wrong password or ordinary workspace admin obtain an owner session", async () => {
    for (const change of ["UPDATE users SET email_verified_at=NULL", "UPDATE users SET email_verified_at=clock_timestamp(),is_platform_owner=false"]) {
      await pool().query(change);
      const response = await platformLogin(request("/api/platform/auth/login", { email: "user@example.test", password }));
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    const bad = await customerLogin(request("/api/auth/login", { email: "user@example.test", password: "wrong password 12" }));
    const absent = await customerLogin(request("/api/auth/login", { email: "absent@example.test", password: "wrong password 12" }));
    expect(bad.status).toBe(401); expect(absent.status).toBe(401);
    expect(await bad.json()).toEqual(await absent.json());
    expect((await pool().query("SELECT id FROM refresh_tokens")).rows).toHaveLength(0);
  });

  it("requires a verified current password proof even when session issuance is called internally", async () => {
    await expect(issueSessionPair({ kind: "platform", userId: "user", email: "user@example.test" })).rejects.toThrow();
    await expect(issueSessionPair({ kind: "customer", userId: "user", tenantId: "a", role: "owner" })).rejects.toThrow();
    expect((await pool().query("SELECT id FROM refresh_tokens")).rows).toHaveLength(0);
  });

  it("selects a workspace once without an extra authentication state", async () => {
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('user','b','admin')");
    const pending = await customerLogin(request("/api/auth/login", { email: "user@example.test", password }));
    expect(pending.status).toBe(409);
    const { selectionToken } = await pending.json();
    const selected = await selectTenant(request("/api/auth/select-tenant", { tenantId: "b", selectionToken }));
    expect(selected.status).toBe(200);
    expect(await validateCustomer(request("/api/auth/me", undefined, cookies(selected)))).toMatchObject({ tenantId: "b", role: "admin" });
    expect((await selectTenant(request("/api/auth/select-tenant", { tenantId: "b", selectionToken }))).status).toBe(409);
  });

  it("an aged workspace login timestamp needs no re-confirmation and keeps the original deadline", async () => {
    const loggedIn = await customerLogin(request("/api/auth/login", { email: "user@example.test", password }));
    expect(loggedIn.status).toBe(200);
    const prior = (await validateCustomer(request("/api/auth/me", undefined, cookies(loggedIn))))!;
    // Backdate created_at too: the time_check constraint requires
    // created_at <= password_verified_at.
    await pool().query("UPDATE workspace_session_security SET created_at=created_at-interval '10 minutes',password_verified_at=clock_timestamp()-interval '6 minutes' WHERE family_id=$1", [prior.familyId]);
    const before = (await pool().query("SELECT expires_at FROM workspace_session_security WHERE family_id=$1", [prior.familyId])).rows[0];
    // No step-up: the same cookies still validate, with no rotation.
    expect(await validateCustomer(request("/api/auth/me", undefined, cookies(loggedIn)))).toMatchObject({ familyId: prior.familyId });
    expect((await pool().query("SELECT expires_at FROM workspace_session_security WHERE family_id=$1", [prior.familyId])).rows[0]).toEqual(before);
  });
  it("an aged platform session authorizes mutations without confirmation and keeps its absolute deadline", async () => {
    const { claims, response: original } = await platformSession();
    await pool().query("UPDATE platform_session_security SET password_verified_at=clock_timestamp()-interval '6 minutes',last_seen_at=clock_timestamp()-interval '2 minutes' WHERE family_id=$1", [claims.familyId]);
    const before = (await pool().query("SELECT expires_at,last_seen_at FROM platform_session_security WHERE family_id=$1", [claims.familyId])).rows[0];
    // No step-up: the aged session passes the mutation authority check.
    await expect(db.transaction(tx => requirePlatformActorInTransaction(tx, claims))).resolves.toBeUndefined();
    expect(await validatePlatformOwner(request("/api/platform/auth/me", undefined, cookies(original)))).toMatchObject({ familyId: claims.familyId });
    expect((await pool().query("SELECT expires_at FROM platform_session_security WHERE family_id=$1", [claims.familyId])).rows[0].expires_at).toEqual(before.expires_at);
  });
  it("rejects platform access, refresh and already-admitted mutation claims after direct password-hash drift", async () => {
    const { claims, response } = await platformSession();
    await pool().query("UPDATE users SET password_hash=$1 WHERE id='user'", [await hashPassword("replacement password 19! ")]);
    expect(await validatePlatformOwner(request("/api/platform/auth/me", undefined, cookies(response)))).toBeNull();
    await expect(db.transaction(tx => requirePlatformActorInTransaction(tx, claims))).rejects.toThrow();
    expect((await rotateRefreshToken("platform", value(response, "plt_refresh"))).status).toBe("invalid");
  });

  it.each(["idle", "absolute"])("an %s-expired platform session stays expired for mutations", async mode => {
    const { claims, response } = await platformSession();
    await pool().query(mode === "idle" ? "UPDATE platform_session_security SET last_seen_at=clock_timestamp()-interval '31 minutes' WHERE family_id=$1" : "UPDATE platform_session_security SET expires_at=clock_timestamp()-interval '1 second' WHERE family_id=$1", [claims.familyId]);
    const before = (await pool().query("SELECT * FROM platform_session_security WHERE family_id=$1", [claims.familyId])).rows;
    await expect(db.transaction(tx => requirePlatformActorInTransaction(tx, claims))).rejects.toThrow();
    expect(await validatePlatformOwner(request("/api/platform/auth/me", undefined, cookies(response)))).toBeNull();
    expect((await pool().query("SELECT * FROM platform_session_security WHERE family_id=$1", [claims.familyId])).rows).toEqual(before);
  });
  it("the final database has no factor tables while retaining session security tables", async () => {
    const rows = (await pool().query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE '%_mfa_%' ORDER BY table_name")).rows;
    expect(rows).toEqual([]);
    const tables = (await pool().query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('platform_session_security','workspace_session_security')")).rows;
    expect(tables).toHaveLength(2);
  });
});
