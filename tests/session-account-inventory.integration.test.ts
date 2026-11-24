import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { issueWorkspaceTestSession } from "./helpers/workspace-session";
import { createVerifiedPlatformPair } from "./helpers/platform-session";
import { hashPassword } from "../src/lib/password";
import { GET, POST } from "../src/app/api/auth/sessions/route";
import { POST as platformPost } from "../src/app/api/platform/auth/sessions/route";
import { isSessionFamilyActive, verifyAccessTokenSignature } from "../src/lib/session-tokens";

const origin = "http://localhost:3000";
const password = " account-inventory-fixture-91! ";
let passwordHash: string;
const pair = (tenantId = "account-a", userId = "account-u", kind: "customer" | "manager" = "customer") =>
  issueWorkspaceTestSession({ kind, tenantId, userId, email: `${userId}@example.test`, role: "admin" });
const request = (token: string, body?: unknown, platformToken?: string, query = "") => new Request(`${origin}/api/auth/sessions${query}`, {
  method: body ? "POST" : "GET", headers: { origin, "content-type": "application/json",
    cookie: `cust_session=${token}${platformToken ? `; plt_session=${platformToken}` : ""}` },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const active = async (family: string) => Number((await pool().query("SELECT count(*)::integer AS n FROM refresh_tokens WHERE family_id=$1 AND revoked_at IS NULL", [family])).rows[0].n) > 0;

describe.skipIf(!hasTestDatabase)("account-wide own-session inventory and authority", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = randomBytes(32).toString("hex");
    process.env.APP_BASE_URL = origin;
    await applyMigrations(); passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants(id,name) VALUES ('account-a','Workspace A'),('account-b','Workspace B')");
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner) VALUES ('account-u','account-u@example.test',$1,clock_timestamp(),true),('account-v','account-v@example.test',$1,clock_timestamp(),false)", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('account-u','account-a','admin'),('account-u','account-b','admin'),('account-v','account-a','admin')");
  });
  afterAll(closePool);

  it("lists all own live workspace/audience families, labels scope and never discloses another account or credentials", async () => {
    const own = await pair(), otherWorkspace = await pair("account-b"), manager = await pair("account-b", "account-u", "manager");
    const platform = await createVerifiedPlatformPair("account-u", "account-u@example.test");
    const foreign = await pair("account-a", "account-v");
    const response = await GET(request(own.accessToken)); expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Set(body.sessions.map((row: { id: string }) => row.id))).toEqual(new Set([own.familyId, otherWorkspace.familyId, manager.familyId, platform.familyId]));
    expect(body.sessions.find((row: { id: string }) => row.id === otherWorkspace.familyId)).toMatchObject({ tenantId: "account-b", tenantName: "Workspace B", kind: "customer", current: false });
    expect(body.sessions.find((row: { id: string }) => row.id === platform.familyId)).toMatchObject({ tenantId: null, kind: "platform" });
    const text = JSON.stringify(body);
    for (const secret of [own.accessToken, own.refreshToken, foreign.familyId, foreign.refreshToken, "passwordHash", "credentialVersion", "tokenHash", "public_key", "secret_encrypted"]) expect(text).not.toContain(secret);
    expect(body.nextCursor).toBeNull();
  });

  it("revokes an owned family in another workspace while rejecting a different user's target", async () => {
    const own = await pair(), target = await pair("account-b"), foreign = await pair("account-a", "account-v");
    const denied = await POST(request(own.accessToken, { action: "revoke", id: foreign.familyId }));
    expect(denied.status).toBe(404); expect(denied.headers.getSetCookie()).toEqual([]);
    const response = await POST(request(own.accessToken, { action: "revoke", id: target.familyId }));
    expect(response.status).toBe(200); expect((await response.json()).signedOut).toBe(false);
    expect(await active(target.familyId)).toBe(false); expect(await active(foreign.familyId)).toBe(true); expect(await active(own.familyId)).toBe(true);
    // No rotation: the caller's own access token stays valid.
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(verifyAccessTokenSignature(own.accessToken, "customer")?.familyId).toBe(own.familyId);
  });

  it("revokes all audiences with the workspace session alone, no platform confirmation", async () => {
    const own = await pair(), workspace = await pair("account-b"), platform = await createVerifiedPlatformPair("account-u", "account-u@example.test");
    // No step-up: no platform token is presented, and the platform proof is
    // deliberately aged past five minutes — revocation still succeeds.
    await pool().query("UPDATE platform_session_security SET password_verified_at=clock_timestamp()-interval '6 minutes' WHERE family_id=$1", [platform.familyId]);
    const allowed = await POST(request(own.accessToken, { action: "revoke_others" }));
    expect(allowed.status).toBe(200);
    expect(await active(own.familyId)).toBe(true);
    for (const family of [workspace.familyId, platform.familyId]) expect(await active(family)).toBe(false);
  });
  it("ends every owned workspace family on revoke_all without touching another account", async () => {
    const own = await pair(), second = await pair("account-b"), manager = await pair("account-b", "account-u", "manager"), foreign = await pair("account-a", "account-v");
    const response = await POST(request(own.accessToken, { action: "revoke_all" }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ signedOut: true, revoked: 3 });
    for (const family of [own.familyId, second.familyId, manager.familyId]) expect(await active(family)).toBe(false);
    expect(await active(foreign.familyId)).toBe(true);
    expect(response.headers.getSetCookie().some(value => value.startsWith("cust_session=") && value.includes("Max-Age=0"))).toBe(true);
  });

  it("lets fresh platform authority terminate the same account's entire inventory", async () => {
    const workspace = await pair(), other = await pair("account-b"), foreign = await pair("account-a", "account-v");
    const platform = await createVerifiedPlatformPair("account-u", "account-u@example.test");
    const response = await platformPost(new Request(`${origin}/api/platform/auth/sessions`, { method: "POST", headers: {
      origin, "content-type": "application/json", cookie: `plt_session=${platform.accessToken}`,
    }, body: JSON.stringify({ action: "revoke_all" }) }));
    expect(response.status).toBe(200); expect((await response.json()).signedOut).toBe(true);
    for (const family of [workspace.familyId, other.familyId, platform.familyId]) expect(await active(family)).toBe(false);
    expect(await active(foreign.familyId)).toBe(true);
  });

  it("session management without password preserves the absolute deadline", async () => {
    const own = await pair(), other = await pair("account-b");
    await pool().query("UPDATE workspace_session_security SET created_at=clock_timestamp()-interval '10 minutes',password_verified_at=clock_timestamp()-interval '10 minutes' WHERE family_id=$1", [own.familyId]);
    const before = (await pool().query("SELECT expires_at FROM workspace_session_security WHERE family_id=$1", [own.familyId])).rows[0];
    expect((await POST(request(own.accessToken, { action: "revoke", id: other.familyId }))).status).toBe(200);
    expect((await pool().query("SELECT expires_at FROM workspace_session_security WHERE family_id=$1", [own.familyId])).rows[0]).toEqual(before);
  });

  it("filters dead policy rows before the page limit and provides bounded signed cursor pagination", async () => {
    const own = await pair();
    const live = [own.familyId]; const stale: string[] = [];
    for (let i = 0; i < 103; i++) live.push((await pair(i % 2 ? "account-a" : "account-b")).familyId);
    for (let i = 0; i < 102; i++) stale.push((await pair()).familyId);
    await pool().query("UPDATE workspace_session_security SET created_at=clock_timestamp()-interval '1 hour',password_verified_at=clock_timestamp()-interval '1 hour',last_seen_at=clock_timestamp()-interval '31 minutes' WHERE family_id=ANY($1::text[])", [stale]);
    const first = await GET(request(own.accessToken)); expect(first.status).toBe(200);
    const body = await first.json(); expect(body.sessions).toHaveLength(100); expect(body.truncated).toBe(true); expect(typeof body.nextCursor).toBe("string");
    const second = await GET(request(own.accessToken, undefined, undefined, `?cursor=${encodeURIComponent(body.nextCursor)}`));
    expect(second.status).toBe(200); const tail = await second.json(); expect(tail.sessions).toHaveLength(4); expect(tail.nextCursor).toBeNull();
    const ids = [...body.sessions, ...tail.sessions].map((row: { id: string }) => row.id);
    expect(new Set(ids).size).toBe(104); expect(new Set(ids)).toEqual(new Set(live));
    const tampered = body.nextCursor.slice(0, -1) + (body.nextCursor.endsWith("A") ? "B" : "A");
    expect((await GET(request(own.accessToken, undefined, undefined, `?cursor=${encodeURIComponent(tampered)}`))).status).toBe(400);
    const foreign = await pair("account-a", "account-v");
    expect((await GET(request(foreign.accessToken, undefined, undefined, `?cursor=${encodeURIComponent(body.nextCursor)}`))).status).toBe(400);
    expect(await isSessionFamilyActive(own.familyId, "customer", "account-a", "account-u")).toBe(true);
  }, 60000);
});
