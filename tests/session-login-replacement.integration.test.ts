import { issueWorkspaceTestSession } from "./helpers/workspace-session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { isSessionFamilyActive, rotateRefreshToken } from "../src/lib/session-tokens";
import { hashPassword } from "../src/lib/password";
import { verifyWorkspaceToken } from "../src/lib/manager-auth";
import { POST as beginCustomerLogin } from "../src/app/api/auth/login/route";
import { POST as beginManagerLogin } from "../src/app/api/auth/manager/login/route";
import { POST as beginSelectTenant } from "../src/app/api/auth/select-tenant/route";

const customerLogin = async (request: Request) => beginCustomerLogin(request);
const managerLogin = async (request: Request) => beginManagerLogin(request);
const selectTenant = async (request: Request) => beginSelectTenant(request);

const password = "session-replacement-regression-42!";
let passwordHash: string;
const request = (endpoint: string, body: unknown, cookie = "") => new Request(`http://localhost:3000${endpoint}`, {
  method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000", cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const responseCookie = (response: Response, name: string) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(";")[0].slice(name.length + 1);
const pair = (kind: "customer" | "manager" = "customer", userId = "u", tenantId = "a") => issueWorkspaceTestSession({ kind, tenantId, userId, email: `${userId}@example.test`, role: "admin" });

describe.skipIf(!hasTestDatabase)("full-login replacement of the presented session", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "session-replacement-tests-secret-at-least-32";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.MANAGER_TENANT_ID = "a";
    await applyMigrations(); passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants(id,name) VALUES ('a','A'),('b','B')");
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at) VALUES ('u','u@example.test',$1,clock_timestamp()),('v','v@example.test',$1,clock_timestamp())", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('u','a','admin'),('u','b','admin'),('v','a','admin')");
  });
  afterAll(closePool);

  it("atomically replaces the presented family after a successful password login", async () => {
    const current = await pair();
    const input = request("/api/auth/login", { email: "u@example.test", password, tenantId: "a" }, `cust_session=${current.accessToken}`);
    const completed = await beginCustomerLogin(input);
    expect(completed.status).toBe(200);
    expect(await verifyWorkspaceToken(current.accessToken)).toBeNull();
    expect(await verifyWorkspaceToken(responseCookie(completed, "cust_session")!)).not.toBeNull();
  });

  it.each(["customer", "manager"] as const)("replaces only the presented same-principal %s family after full login", async kind => {
    const current = await pair(kind), otherDevice = await pair(kind), otherUser = await pair(kind, "v"), otherTenant = await pair(kind, "u", "b");
    const otherKind = await pair(kind === "customer" ? "manager" : "customer");
    const prefix = kind === "customer" ? "cust" : "mgr";
    const cookies = `${prefix}_session=${current.accessToken}; ${prefix}_refresh=${current.refreshToken}; ${kind === "customer" ? "mgr" : "cust"}_session=${otherKind.accessToken}`;
    const response = kind === "customer"
      ? await customerLogin(request("/api/auth/login", { email: "u@example.test", password, tenantId: "a" }, cookies))
      : await managerLogin(request("/api/auth/manager/login", { username: "u@example.test", password }, cookies));
    expect(response.status).toBe(200);
    expect(await verifyWorkspaceToken(current.accessToken)).toBeNull();
    expect((await rotateRefreshToken(kind, current.refreshToken)).status).toBe("invalid");
    const replacement = await verifyWorkspaceToken(responseCookie(response, `${prefix}_session`)!);
    expect(replacement).toMatchObject({ kind, tenantId: "a", userId: "u" });
    expect(replacement!.familyId).not.toBe(current.familyId);
    for (const [session, candidateKind, userId, tenantId] of [[otherDevice, kind, "u", "a"], [otherUser, kind, "v", "a"], [otherTenant, kind, "u", "b"], [otherKind, kind === "customer" ? "manager" : "customer", "u", "a"]] as const) {
      expect(await isSessionFamilyActive(session.familyId, candidateKind, tenantId, userId)).toBe(true);
    }
    expect(JSON.stringify(await response.json())).not.toMatch(/accessToken|refreshToken/);
  });

  it("replaces the refresh-only current family after access-cookie expiry", async () => {
    const current = await pair();
    const response = await customerLogin(request("/api/auth/login", { email: "u@example.test", password, tenantId: "a" }, `cust_refresh=${current.refreshToken}`));
    expect(response.status).toBe(200);
    expect(await isSessionFamilyActive(current.familyId, "customer", "a", "u")).toBe(false);
    expect(await verifyWorkspaceToken(responseCookie(response, "cust_session")!)).not.toBeNull();
  });

  it("preserves a different principal or tenant and never revokes on failed authentication", async () => {
    for (const current of [await pair("customer", "v"), await pair("customer", "u", "b")]) {
      const before = await verifyWorkspaceToken(current.accessToken);
      expect((await customerLogin(request("/api/auth/login", { email: "u@example.test", password: "incorrect", tenantId: "a" }, `cust_session=${current.accessToken}`))).status).toBe(401);
      expect((await customerLogin(request("/api/auth/login", { email: "u@example.test", password, tenantId: "a" }, `cust_session=${current.accessToken}`))).status).toBe(200);
      expect(await verifyWorkspaceToken(current.accessToken)).toEqual(before);
    }
  });

  it("password-based tenant selection replaces the customer family without revoking an unrelated manager", async () => {
    const current = await pair(), manager = await pair("manager", "v");
    const cookies = `cust_session=${current.accessToken}; mgr_session=${manager.accessToken}`;
    const pending = await customerLogin(request("/api/auth/login", { email: "u@example.test", password }, cookies));
    expect(pending.status).toBe(409); expect(await verifyWorkspaceToken(current.accessToken)).not.toBeNull();
    const { selectionToken } = await pending.json();
    expect((await selectTenant(request("/api/auth/select-tenant", { tenantId: "a", selectionToken }, cookies))).status).toBe(200);
    expect(await verifyWorkspaceToken(current.accessToken)).toBeNull();
    expect(await verifyWorkspaceToken(manager.accessToken)).not.toBeNull();
  });

  it("terminates only the presented legacy manager login after fresh credentials succeed", async () => {
    const now = Number((await pool().query("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) AS n")).rows[0].n);
    const jti = `legacy_${randomBytes(16).toString("hex")}`, otherJti = `legacy_${randomBytes(16).toString("hex")}`;
    await pool().query("INSERT INTO manager_sessions(jti,tenant_id,user_id,role,expires_at) VALUES ($1,'a','u','admin',to_timestamp($3)),($2,'a','u','admin',to_timestamp($3))", [jti, otherJti, now + 28800]);
    const encoded = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: "manager", jti, iat: now, exp: now + 28800, tenantId: "a", userId: "u", role: "admin" })).toString("base64url")].join(".");
    const token = `${encoded}.${createHmac("sha256", process.env.GATEWAY_JWT_SECRET!).update(encoded).digest("base64url")}`;
    expect((await managerLogin(request("/api/auth/manager/login", { username: "u@example.test", password }, `mgr_session=${token}`))).status).toBe(200);
    expect((await pool().query("SELECT revoked_at FROM manager_sessions WHERE jti=$1", [jti])).rows[0].revoked_at).not.toBeNull();
    expect((await pool().query("SELECT revoked_at FROM manager_sessions WHERE jti=$1", [otherJti])).rows[0].revoked_at).toBeNull();
  });

  it("rolls back current-session revocation if the replacement insert fails", async () => {
    const current = await pair();
    await pool().query("CREATE FUNCTION reject_replacement_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic replacement insert refused'; END $$");
    await pool().query("CREATE TRIGGER reject_replacement_test BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION reject_replacement_test()");
    try {
      const failed = await customerLogin(request("/api/auth/login", { email: "u@example.test", password, tenantId: "a" }, `cust_session=${current.accessToken}`));
      expect(failed.status).toBe(503);
      expect(failed.headers.getSetCookie()).toEqual([]);
      expect(await verifyWorkspaceToken(current.accessToken)).not.toBeNull();
      expect((await pool().query("SELECT revoked_at FROM refresh_tokens WHERE id=$1", [current.refreshTokenId])).rows[0].revoked_at).toBeNull();
    } finally {
      await pool().query("DROP TRIGGER reject_replacement_test ON refresh_tokens");
      await pool().query("DROP FUNCTION reject_replacement_test()");
    }
  });
});
