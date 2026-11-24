import { issueWorkspaceTestSession } from "./helpers/workspace-session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { isSessionFamilyActive, rotateRefreshToken } from "../src/lib/session-tokens";
import { GET, POST } from "../src/app/api/auth/sessions/route";
import { hashPassword } from "../src/lib/password";
import { validateWorkspaceManager, verifyWorkspaceToken } from "../src/lib/manager-auth";
import { revokeOwnSessions } from "../src/lib/session-inventory";
import { requireManagerActorInTransaction } from "../src/lib/manager-mutation-authorization";
import { requireTeamActorInTransaction } from "../src/lib/team-authorization";
import { requireActiveTenantInTransaction } from "../src/lib/tenant-guard";
import { db } from "../src/db";
import { createHmac, randomBytes } from "node:crypto";
import { POST as logout } from "../src/app/api/auth/logout/route";

let passwordHash: string;
const password = "session-inventory-fixture-93!";

describe.skipIf(!hasTestDatabase)("customer-owned account-wide session inventory", () => {
  beforeAll(async () => { process.env.GATEWAY_JWT_SECRET = "session-inventory-tests-secret-at-least-32"; process.env.APP_BASE_URL = "http://localhost:3000"; await applyMigrations(); passwordHash = await hashPassword(password); });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants(id,name) VALUES ('a','A'),('b','B')");
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at) VALUES ('u','u@example.test',$1,clock_timestamp()),('v','v@example.test',$1,clock_timestamp())", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('u','a','admin'),('u','b','admin'),('v','a','admin')");
  });
  afterAll(closePool);
  const pair = (tenantId: string, userId = "u") => issueWorkspaceTestSession({ kind: "customer", tenantId, userId, email: `${userId}@example.test`, role: "admin" });
  const req = (token: string, body?: unknown) => new Request("http://localhost:3000/api/auth/sessions", {
    method: body ? "POST" : "GET", headers: { cookie: `cust_session=${token}`, origin: "http://localhost:3000", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookie = (response: Response, name: string) => response.headers.getSetCookie()
    .find(value => value.startsWith(`${name}=`))?.split(";")[0].slice(name.length + 1);

  it("lists the current user's workspaces and never another account, tokens or hashes", async () => {
    const own = await pair("a"), otherTenant = await pair("b"), otherUser = await pair("a", "v");
    const response = await GET(req(own.accessToken));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Set(body.sessions.map((s: { id: string }) => s.id))).toEqual(new Set([own.familyId, otherTenant.familyId]));
    expect(body.sessions.find((s: { id: string }) => s.id === own.familyId).current).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain(own.refreshToken);
    expect(text).not.toContain("tokenHash");
    expect(body.sessions.find((s: { id: string }) => s.id === otherTenant.familyId)).toMatchObject({ tenantId: "b", tenantName: "B", current: false });
    expect(text).not.toContain(otherUser.familyId);
  });

  it("denies other accounts and unknown targets and revokes other sessions across the user's workspaces", async () => {
    const own = await pair("a"), ownOther = await pair("a"), otherTenant = await pair("b"), otherUser = await pair("a", "v");
    expect((await POST(req(own.accessToken, { action: "revoke", id: "f".repeat(32) }))).status).toBe(404);
    expect((await POST(req(own.accessToken, { action: "revoke", id: otherUser.familyId }))).status).toBe(404);
    expect((await POST(req(own.accessToken, { action: "revoke_others" }))).status).toBe(200);
    expect(await isSessionFamilyActive(own.familyId, "customer", "a", "u")).toBe(true);
    expect(await isSessionFamilyActive(ownOther.familyId, "customer", "a", "u")).toBe(false);
    expect(await isSessionFamilyActive(otherTenant.familyId, "customer", "b", "u")).toBe(false);
    expect(await isSessionFamilyActive(otherUser.familyId, "customer", "a", "v")).toBe(true);
  });

  it("revokes without password confirmation", async () => {
    const own = await pair("a"), ownOther = await pair("a");
    expect((await POST(req(own.accessToken, { action: "revoke", id: ownOther.familyId }))).status).toBe(200);
    expect(await isSessionFamilyActive(ownOther.familyId, "customer", "a", "u")).toBe(false);
    expect(await isSessionFamilyActive(own.familyId, "customer", "a", "u")).toBe(true);
    // The caller's own session is untouched: no rotation cookies are issued.
    expect(await verifyWorkspaceToken(own.accessToken)).not.toBeNull();
  });
  it.each(["customer", "manager"] as const)("keeps the caller session unchanged when revoking another %s session", async kind => {
    await pool().query("UPDATE tenant_users SET role='owner' WHERE user_id='u' AND tenant_id='a'");
    const current = await issueWorkspaceTestSession({ kind, tenantId: "a", userId: "u", email: "u@example.test", role: "owner" });
    const other = await issueWorkspaceTestSession({ kind, tenantId: "a", userId: "u", email: "u@example.test", role: "owner" });
    await pool().query("UPDATE refresh_tokens SET family_created_at=family_created_at-interval '1 day', expires_at=expires_at-interval '1 day' WHERE family_id=$1", [current.familyId]);
    const before = (await pool().query("SELECT family_created_at, expires_at FROM refresh_tokens WHERE id=$1", [current.refreshTokenId])).rows[0];
    const prefix = kind === "customer" ? "cust" : "mgr";
    const request = (body?: unknown) => new Request("http://localhost:3000/api/auth/sessions", {
      method: body ? "POST" : "GET", headers: { cookie: `${prefix}_session=${current.accessToken}`, origin: "http://localhost:3000", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const response = await POST(request({ action: "revoke", id: other.familyId }));
    expect(response.status).toBe(200);
    // No step-up and no rotation: revocation sets no session cookies at all.
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = await response.json();
    expect(body.signedOut).toBe(false);
    expect(await verifyWorkspaceToken(current.accessToken)).not.toBeNull();
    expect(await isSessionFamilyActive(other.familyId, kind, "a", "u")).toBe(false);
    const after = (await pool().query("SELECT family_created_at, expires_at FROM refresh_tokens WHERE id=$1", [current.refreshTokenId])).rows[0];
    expect(after).toEqual(before);
    // The caller's authority is unchanged at the mutation boundary.
    const liveClaims = (await validateWorkspaceManager(request()))!;
    await expect(db.transaction(async tx => {
      await requireActiveTenantInTransaction(tx, "a");
      await requireManagerActorInTransaction(tx, liveClaims, "tenant.read");
    })).resolves.toBeUndefined();
    // The team gate is a separate fail-closed obsolete gate (always
    // throws), unrelated to step-up.
    await expect(db.transaction(tx => requireTeamActorInTransaction(tx, liveClaims))).rejects.toThrow(/restricted to Platform Owner/);
  });
  it("does not terminate the caller for a foreign target", async () => {
    const current = await pair("a"), other = await pair("a"), foreign = await pair("a", "v");
    for (const [id, status] of [[foreign.familyId, 404], [other.familyId, 200]] as const) {
      const response = await POST(req(current.accessToken, { action: "revoke", id }));
      expect(response.status).toBe(status);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await verifyWorkspaceToken(current.accessToken)).not.toBeNull();
      expect((await pool().query("SELECT COUNT(*)::integer AS n FROM refresh_tokens WHERE family_id=$1", [current.familyId])).rows[0].n).toBe(1);
    }
  });
  it("revocation without password preserves the caller's shorter persisted expiry through refresh", async () => {
    const current = await pair("a");
    await pool().query("UPDATE refresh_tokens SET expires_at=clock_timestamp()+interval '2 hours' WHERE family_id=$1", [current.familyId]);
    const expiresAt = (await pool().query("SELECT expires_at FROM refresh_tokens WHERE id=$1", [current.refreshTokenId])).rows[0].expires_at;
    const response = await POST(req(current.accessToken, { action: "revoke_others" }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    const refreshed = await rotateRefreshToken("customer", current.refreshToken);
    expect(refreshed.status).toBe("rotated");
    if (refreshed.status === "rotated") expect(refreshed.pair.refreshExpiresAt).toEqual(expiresAt);
  });
  it("rejects a changed credential at revocation without mutating the ledger", async () => {
    const current = await pair("a"), other = await pair("a");
    const claims = (await validateWorkspaceManager(req(current.accessToken)))!;
    await pool().query("UPDATE users SET password_hash=$1 WHERE id='u'", [await hashPassword("replacement-session-password-34!")]);
    await expect(revokeOwnSessions({ scope: "workspace", claims }, "revoke", other.familyId)).rejects.toThrow(/expired or changed/i);
    // A changed password now invalidates all workspace proof at admission,
    // while the rejected operation itself must not mutate the refresh ledger.
    expect(await isSessionFamilyActive(other.familyId, "customer", "a", "u")).toBe(false);
    expect((await pool().query("SELECT revoked_at FROM refresh_tokens WHERE id=$1", [other.refreshTokenId])).rows[0].revoked_at).toBeNull();
    expect((await pool().query("SELECT COUNT(*)::integer AS n FROM refresh_tokens WHERE family_id=$1", [current.familyId])).rows[0].n).toBe(1);
  });
  it("concurrent revoke_others is idempotent and keeps the caller's session", async () => {
    const current = await pair("a");
    const results = await Promise.all([1, 2].map(() => POST(req(current.accessToken, { action: "revoke_others" }))));
    expect(results.map(response => response.status)).toEqual([200, 200]);
    const live = await pool().query("SELECT id FROM refresh_tokens WHERE family_id=$1 AND revoked_at IS NULL", [current.familyId]);
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0].id).toBe(current.refreshTokenId);
    expect(await verifyWorkspaceToken(current.accessToken)).not.toBeNull();
  });
  it("revoke_others concurrent with refresh leaves exactly one current caller token", async () => {
    const current = await pair("a");
    const [response, refresh] = await Promise.all([
      POST(req(current.accessToken, { action: "revoke_others" })),
      rotateRefreshToken("customer", current.refreshToken),
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    // Refresh rotation replaces rather than revokes the predecessor
    // (replaced_by is set, revoked_at stays null), so "current" is the
    // row with no successor — there is exactly one, with or without revoke.
    const live = await pool().query("SELECT id FROM refresh_tokens WHERE family_id=$1 AND revoked_at IS NULL AND replaced_by IS NULL", [current.familyId]);
    expect(live.rows).toHaveLength(1);
    if (refresh.status === "rotated") {
      expect(live.rows[0].id).not.toBe(current.refreshTokenId);
      expect(await verifyWorkspaceToken(refresh.pair.accessToken)).not.toBeNull();
      // No second-rotation assertion: refresh rotation has a grace window
      // in which a replaced token may still rotate, so reuse is not a
      // stable fence here; the single-current-token assertion above is.
    } else {
      expect(refresh.status).toBe("invalid");
      expect(live.rows[0].id).toBe(current.refreshTokenId);
    }
  });
  it("revoke_others concurrent with logout leaves no surviving caller family", async () => {
    const current = await pair("a");
    const [response, signedOut] = await Promise.all([
      POST(req(current.accessToken, { action: "revoke_others" })),
      logout(new Request("http://localhost:3000/api/auth/logout", { method: "POST", headers: { cookie: `cust_session=${current.accessToken}` } })),
    ]);
    expect(signedOut.status).toBe(200);
    expect([200, 401, 403]).toContain(response.status);
    if (response.status === 200) expect(response.headers.getSetCookie()).toEqual([]);
    expect(await isSessionFamilyActive(current.familyId, "customer", "a", "u")).toBe(false);
    expect((await rotateRefreshToken("customer", current.refreshToken)).status).toBe("invalid");
  });
  it("requires a new login before legacy sessions can revoke", async () => {
    const jti = `legacy_${randomBytes(16).toString("hex")}`;
    const now = Number((await pool().query("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) AS now")).rows[0].now);
    const claims = { sub: "manager", jti, iat: now, exp: now + 8 * 3600, tenantId: "a", userId: "u", role: "admin" };
    const encoded = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url")].join(".");
    const token = `${encoded}.${createHmac("sha256", process.env.GATEWAY_JWT_SECRET!).update(encoded).digest("base64url")}`;
    await pool().query("INSERT INTO manager_sessions(jti,tenant_id,user_id,role,expires_at) VALUES ($1,'a','u','admin',to_timestamp($2))", [jti, claims.exp]);
    const other = await pair("a"), foreign = await pair("b");
    const request = (id: string) => new Request("http://localhost:3000/api/auth/sessions", { method: "POST", headers: {
      cookie: `mgr_session=${token}`, origin: "http://localhost:3000", "content-type": "application/json",
    }, body: JSON.stringify({ action: "revoke", id }) });
    const denied = await POST(request(foreign.familyId));
    expect(denied.status).toBe(401);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(await verifyWorkspaceToken(token)).toBeNull();
    const response = await POST(request(other.familyId));
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await verifyWorkspaceToken(token)).toBeNull();
    expect(await isSessionFamilyActive(other.familyId, "customer", "a", "u")).toBe(true);
    expect(await isSessionFamilyActive(foreign.familyId, "customer", "b", "u")).toBe(true);
  });
});
