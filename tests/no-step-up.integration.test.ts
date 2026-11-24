import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { hashPassword } from "../src/lib/password";
import { issueWorkspaceTestSession } from "./helpers/workspace-session";
import { createVerifiedPlatformPair } from "./helpers/platform-session";
import { requireManagerActorInTransaction } from "../src/lib/manager-mutation-authorization";
import { requirePlatformActorInTransaction, validatePlatformOwner } from "../src/lib/platform-auth";
import { requireActiveTenantInTransaction } from "../src/lib/tenant-guard";
import { validateWorkspaceManager } from "../src/lib/manager-auth";
import { isSessionFamilyActive } from "../src/lib/session-tokens";
import { db } from "../src/db";
import { POST as workspaceLogin } from "../src/app/api/auth/login/route";
import { POST as platformLogin } from "../src/app/api/platform/auth/login/route";
import { PATCH as updateSettings } from "../src/app/api/settings/route";
import { POST as createPlan } from "../src/app/api/platform/plans/route";
import { POST as workspaceRevoke } from "../src/app/api/auth/sessions/route";
import { POST as platformRevoke } from "../src/app/api/platform/auth/sessions/route";
import { GET as workspaceSessions } from "../src/app/api/auth/sessions/route";

// User-ordered behaviour change (v5-nostepup): a valid, non-expired,
// non-revoked session authorizes sensitive actions in Gateway AND Platform
// Admin with NO password re-confirmation, however old the login timestamp is
// (as long as idle/absolute limits still hold). Login itself still requires
// the password, and expiry/revocation/CSRF/tenant isolation still fail closed.
const password = "no-step-up-fixture-93!";
let passwordHash: string;
const origin = "http://localhost:3000";
const wsReq = (path: string, token: string, body?: unknown, method = "POST") => new Request(origin + path, {
  method: body === undefined ? "GET" : method,
  headers: { origin, "content-type": "application/json", cookie: `cust_session=${token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const pltReq = (path: string, token: string, body?: unknown, extra: Record<string, string> = {}) => new Request(origin + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { origin, "content-type": "application/json", cookie: `plt_session=${token}`, ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe.skipIf(!hasTestDatabase)("no password step-up for logged-in sessions", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "no-step-up-tests-secret-at-least-32";
    process.env.APP_BASE_URL = origin;
    await applyMigrations(); passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants(id,name) VALUES ('a','A'),('b','B')");
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner) VALUES ('u','u@example.test',$1,clock_timestamp(),true),('v','v@example.test',$1,clock_timestamp(),false)", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('u','a','owner'),('u','b','owner'),('v','a','admin')");
  });
  afterAll(closePool);
  const workspacePair = (tenantId = "a", userId = "u") => issueWorkspaceTestSession({ kind: "customer", tenantId, userId, email: `${userId}@example.test`, role: userId === "u" ? "owner" : "admin" });
  const platformPair = () => createVerifiedPlatformPair("u", "u@example.test");

  it("(a) Gateway sensitive action succeeds with a login timestamp 40 minutes old", async () => {
    const current = await workspacePair();
    await pool().query("UPDATE workspace_session_security SET created_at=created_at-interval '50 minutes',password_verified_at=clock_timestamp()-interval '40 minutes',last_seen_at=clock_timestamp()-interval '5 minutes' WHERE family_id=$1", [current.familyId]);
    const claims = (await validateWorkspaceManager(wsReq("/api/auth/me", current.accessToken)))!;
    await expect(db.transaction(async tx => { await requireActiveTenantInTransaction(tx, "a"); await requireManagerActorInTransaction(tx, claims, "tenant.update"); })).resolves.toBeUndefined();
    const response = await updateSettings(new Request(origin + "/api/settings", { method: "PATCH", headers: { origin, cookie: `cust_session=${current.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed without step-up" }) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Yaseir-Reauthentication")).toBeNull();
    expect((await pool().query("SELECT name FROM tenants WHERE id='a'")).rows[0].name).toBe("Renamed without step-up");
  });

  it("(b) Platform Admin action succeeds with a login timestamp 40 minutes old", async () => {
    const current = await platformPair();
    const claims = (await validatePlatformOwner(pltReq("/api/platform/auth/me", current.accessToken)))!;
    await pool().query("UPDATE platform_session_security SET password_verified_at=clock_timestamp()-interval '40 minutes',last_seen_at=clock_timestamp()-interval '2 minutes' WHERE family_id=$1", [current.familyId]);
    await expect(db.transaction(tx => requirePlatformActorInTransaction(tx, claims))).resolves.toBeUndefined();
    const response = await createPlan(pltReq("/api/platform/plans", current.accessToken, { id: "nostepup-plan", name: "No step-up plan", description: "Created with an aged session", monthlyQuota: 100, displayOrder: 1, priceAmount: null, priceCurrency: null }, { "Idempotency-Key": "nostepup-plan-key" }));
    expect(response.status).toBe(201);
    expect((await pool().query("SELECT count(*)::integer n FROM plans WHERE id='nostepup-plan'")).rows[0].n).toBe(1);
  });

  it("(c) revoking another session works without a password in both scopes", async () => {
    const own = await workspacePair(), other = await workspacePair(), platformOther = await platformPair();
    const response = await workspaceRevoke(wsReq("/api/auth/sessions", own.accessToken, { action: "revoke_others" }));
    expect(response.status).toBe(200);
    expect(await isSessionFamilyActive(other.familyId, "customer", "a", "u")).toBe(false);
    expect(await isSessionFamilyActive(own.familyId, "customer", "a", "u")).toBe(true);
    expect(await isSessionFamilyActive(platformOther.familyId, "platform", null, "u")).toBe(false);
    // Platform-scope revocation likewise needs no password.
    const platformOwn = await platformPair();
    const platformResponse = await platformRevoke(pltReq("/api/platform/auth/sessions", platformOwn.accessToken, { action: "revoke_others" }));
    expect(platformResponse.status).toBe(200);
  });

  it("(d) login still requires the password in both scopes", async () => {
    expect((await workspaceLogin(wsReq("/api/auth/login", "", { email: "u@example.test", password: "wrong password", tenantId: "a" }))).status).toBe(401);
    expect((await workspaceLogin(wsReq("/api/auth/login", "", { email: "u@example.test", password, tenantId: "a" }))).status).toBe(200);
    expect((await platformLogin(pltReq("/api/platform/auth/login", "", { email: "u@example.test", password: "wrong password" }))).status).toBe(401);
    expect((await platformLogin(pltReq("/api/platform/auth/login", "", { email: "u@example.test", password }))).status).toBe(200);
  });

  it("(e) expired and revoked sessions still fail", async () => {
    const idle = await workspacePair();
    await pool().query("UPDATE workspace_session_security SET created_at=created_at-interval '40 minutes',password_verified_at=created_at,last_seen_at=clock_timestamp()-interval '31 minutes' WHERE family_id=$1", [idle.familyId]);
    expect(await validateWorkspaceManager(wsReq("/api/auth/me", idle.accessToken))).toBeNull();
    expect((await workspaceSessions(wsReq("/api/auth/sessions", idle.accessToken))).status).toBe(401);
    const revoked = await workspacePair();
    await pool().query("UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1", [revoked.familyId]);
    expect(await validateWorkspaceManager(wsReq("/api/auth/me", revoked.accessToken))).toBeNull();
    const claims = (await validateWorkspaceManager(wsReq("/api/auth/me", (await workspacePair()).accessToken)))!;
    await expect(db.transaction(async tx => { await requireActiveTenantInTransaction(tx, "a"); await requireManagerActorInTransaction(tx, { ...claims, sid: "deadbeefdeadbeefdeadbeefdeadbeef" }, "tenant.update"); })).rejects.toThrow();
  });

  it("(f) CSRF/origin and tenant isolation still hold on the same actions", async () => {
    const own = await workspacePair(), foreign = await workspacePair("a", "v");
    // Sessions revocation enforces the workspace origin check; a hostile
    // origin is rejected before any revocation happens.
    const hostile = await workspaceRevoke(new Request(origin + "/api/auth/sessions", { method: "POST", headers: { origin: "https://attacker.invalid", cookie: `cust_session=${own.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ action: "revoke_others" }) }));
    expect(hostile.status).toBe(403);
    expect(await isSessionFamilyActive(foreign.familyId, "customer", "a", "v")).toBe(true);
    const denied = await workspaceRevoke(wsReq("/api/auth/sessions", own.accessToken, { action: "revoke", id: foreign.familyId }));
    expect(denied.status).toBe(404);
    expect(await isSessionFamilyActive(foreign.familyId, "customer", "a", "v")).toBe(true);
    // A workspace session alone cannot use the platform inventory.
    expect((await platformRevoke(pltReq("/api/platform/auth/sessions", own.accessToken, { action: "revoke_others" }))).status).toBe(401);
  });
});
