import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { hashPassword } from "../src/lib/password";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as listInvites, POST as invite, DELETE as revoke } from "../src/app/api/team/invitations/route";

const mail = vi.hoisted(() => ({ send: vi.fn(async (_message: unknown) => undefined) }));
vi.mock("../src/lib/email", async importActual => ({
  ...await importActual<typeof import("../src/lib/email")>(),
  sendTransactionalEmail: mail.send,
}));

const origin = "http://localhost:3000";
const password = "Tested workspace invitation session 19!";
let passwordHash: string;
function request(path: string, method: "GET" | "POST" | "DELETE", cookie: string, body?: Record<string, unknown>, urlOrigin = origin) {
  return new Request(urlOrigin + path, {
    method,
    headers: { origin: urlOrigin, host: new URL(urlOrigin).host, cookie,
      "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function cookieFor(email: string, tenantId = "alpha") {
  const res = await login(request("/api/auth/login", "POST", "", { email, password, tenantId }));
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find(value => value.startsWith("cust_session="))?.split(";")[0] ?? "";
  expect(cookie).toContain("cust_session=");
  return cookie;
}
async function countPending() {
  const rows = await pool().query("SELECT id,tenant_id,inviter_user_id,email,role,token_hash,revoked_at FROM tenant_invitations ORDER BY id");
  return rows.rows as Array<{id:string;tenant_id:string;inviter_user_id:string;email:string;role:string;token_hash:string;revoked_at:Date|null}>;
}

describe.skipIf(!hasTestDatabase)("session-backed workspace owner invitations", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = randomBytes(32).toString("base64url");
    process.env.APP_BASE_URL = origin;
    await applyMigrations();
    passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    mail.send.mockReset();
    mail.send.mockResolvedValue(undefined);
    await pool().query("INSERT INTO tenants(id,name) VALUES ('alpha','Alpha'),('beta','Beta')");
    await pool().query(`INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner)
      VALUES ('owner','owner@example.test',$1,clock_timestamp(),true),
             ('member','member@example.test',$1,clock_timestamp(),false)`, [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('owner','alpha','admin'),('member','alpha','owner')");
  });
  afterAll(closePool);

  it("sends a Full Access invitation through the signed-in verified workspace owner session without another password", async () => {
    const cookie = await cookieFor("member@example.test");
    const res = await invite(request("/api/team/invitations", "POST", cookie, {email:"colleague@example.test"}));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ok:true});
    const pending = await countPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({tenant_id:"alpha",inviter_user_id:"member",email:"colleague@example.test",role:"admin"});
    expect(pending[0]!.token_hash).not.toBe("");
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0]?.[0] as {to?:string;text?:string};
    expect(message.to).toBe("colleague@example.test");
    expect(message.text).toContain("/invite?token=");
  });

  it("does not disclose pending invitation emails to Full Access members", async () => {
    const owner = await cookieFor("member@example.test");
    const member = await cookieFor("owner@example.test");
    const created = await invite(request("/api/team/invitations", "POST", owner, { email: "private.invitee@example.test" }));
    expect(created.status).toBe(201);
    const denied = await listInvites(request("/api/team/invitations", "GET", member));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "OWNER_REQUIRED" });
    const visible = await listInvites(request("/api/team/invitations", "GET", owner));
    expect(visible.status).toBe(200);
    const response = await visible.json();
    expect(response.invitations).toHaveLength(1);
    expect(response.invitations[0]).toMatchObject({ email: "private.invitee@example.test" });
    expect(response.invitations[0]).not.toHaveProperty("tokenHash");
  });

  it("loss of owner email verification invalidates the existing invitation-reading session", async () => {
    const owner = await cookieFor("member@example.test");
    await pool().query("UPDATE users SET email_verified_at=NULL WHERE id='member'");
    const denied = await listInvites(request("/api/team/invitations", "GET", owner));
    // Authentication rejects an account that has lost mailbox verification
    // before owner-only authorization can run. A revoked session is 401,
    // whereas a valid Full Access member without owner rights gets 403.
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("denies a verified Platform Owner who has only Full Access in this workspace", async () => {
    const cookie = await cookieFor("owner@example.test");
    const res = await invite(request("/api/team/invitations","POST",cookie,{email:"guest@example.test"}));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({code:"OWNER_REQUIRED"});
    expect(await countPending()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("loss of email verification invalidates invitation-writing authentication", async () => {
    const cookie = await cookieFor("member@example.test");
    await pool().query("UPDATE users SET email_verified_at=NULL WHERE id='member'");
    const res = await invite(request("/api/team/invitations","POST",cookie,{email:"guest@example.test"}));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await countPending()).toHaveLength(0);
  });

  it("denies cross-origin invitation writes and never accepts a client-selected role", async () => {
    const cookie = await cookieFor("member@example.test");
    const invalidRole = await invite(request("/api/team/invitations","POST",cookie,{email:"guest@example.test",role:"owner"}));
    expect(invalidRole.status).toBe(400);
    const invalidOrigin = await invite(request("/api/team/invitations","POST",cookie,{email:"guest@example.test"},"https://attacker.example"));
    expect(invalidOrigin.status).toBe(403);
    expect(await countPending()).toHaveLength(0);
  });

  it("revoke works with the same session, still scoped to its workspace, and is denied to other members", async () => {
    const owner = await cookieFor("member@example.test");
    const member = await cookieFor("owner@example.test");
    const created = await invite(request("/api/team/invitations","POST",owner,{email:"colleague@example.test"}));
    expect(created.status).toBe(201);
    const id = (await countPending())[0]!.id;
    const unauthorized = await revoke(request("/api/team/invitations?id="+encodeURIComponent(id),"DELETE",member));
    expect(unauthorized.status).toBe(403);
    expect((await countPending())[0]!.revoked_at).toBeNull();
    const result = await revoke(request("/api/team/invitations?id="+encodeURIComponent(id),"DELETE",owner));
    expect(result.status).toBe(200);
    expect((await countPending())[0]!.revoked_at).not.toBeNull();
  });

  it("reports ambiguous mail delivery without claiming success or deleting the invitation", async () => {
    const cookie = await cookieFor("member@example.test");
    mail.send.mockRejectedValueOnce(new Error("mail transport unavailable"));
    const res = await invite(request("/api/team/invitations","POST",cookie,{email:"colleague@example.test"}));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({code:"INVITATION_DELIVERY_UNAVAILABLE"});
    expect(await countPending()).toHaveLength(1);
  });
});
