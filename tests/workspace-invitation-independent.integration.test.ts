import type * as PasswordScreeningModule from "../src/lib/password-screening";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { hashPassword, hashToken } from "../src/lib/password";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as acceptInvitation } from "../src/app/api/team/invitations/accept/route";
import { POST as selectTenant } from "../src/app/api/auth/select-tenant/route";
import { PATCH as updateSettings } from "../src/app/api/settings/route";
import { verifyWorkspaceToken } from "../src/lib/manager-auth";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";

// Only the external password-breach transport is deterministic. Login,
// invitation, reset, revocation and all database transactions are real.
vi.mock("../src/lib/password-screening", async importActual => ({
  ...await importActual<typeof PasswordScreeningModule>(),
  screenNewPassword: vi.fn(async () => "acceptable"),
}));

const password = "independent-invitation-proof-93!";
let passwordHash: string;
const cookie = (response: Response) => response.headers.getSetCookie().find(value => value.startsWith("cust_session="))?.split(";")[0].slice("cust_session=".length) ?? "";
const request = (path: string, access: string, body: unknown, method = "POST") => new Request(`http://localhost:3000${path}`, {
  method, headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie: `cust_session=${access}` }, body: JSON.stringify(body),
});

async function currentSession() {
  const signedIn = await login(request("/api/auth/login", "", { email: "invitee@example.test", password, tenantId: "source" }));
  expect(signedIn.status).toBe(200);
  const access = cookie(signedIn);
  expect(access).toBeTruthy();
  return { access, claims: (await verifyWorkspaceToken(access))! };
}
async function invitation() {
  const token = randomBytes(32).toString("base64url");
  await pool().query("INSERT INTO tenant_invitations(id,tenant_id,inviter_user_id,email,role,token_hash,expires_at) VALUES ('invitation','invited','inviter','invitee@example.test','admin',$1,clock_timestamp()+interval '1 hour')", [await hashToken(token)]);
  return token;
}
async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await pool().query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Invitation did not reach the expected database fence");
}
async function expectInvitationUntouched() {
  expect((await pool().query("SELECT accepted_at FROM tenant_invitations WHERE id='invitation'")).rows[0].accepted_at).toBeNull();
  expect((await pool().query("SELECT 1 FROM tenant_users WHERE tenant_id='invited' AND user_id='invitee'")).rows).toHaveLength(0);
  expect((await pool().query("SELECT 1 FROM workspace_session_security WHERE tenant_id='invited' AND user_id='invitee'")).rows).toHaveLength(0);
}

describe.skipIf(!hasTestDatabase)("independent invitation session-authority review", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = randomBytes(32).toString("base64url");
    process.env.APP_BASE_URL = "http://localhost:3000";
    await applyMigrations(); passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants(id,name) VALUES ('source','Source workspace'),('invited','Invited workspace')");
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at) VALUES ('invitee','invitee@example.test',$1,clock_timestamp()),('inviter','inviter@example.test',$1,clock_timestamp())", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('invitee','source','owner'),('inviter','invited','owner')");
  });
  afterAll(closePool);

  it("accepting a Full Access invitation cannot refresh login authority or extend the original lifetime", async () => {
    const { access: originalAccess, claims: original } = await currentSession();
    await pool().query("UPDATE workspace_session_security SET created_at=created_at-interval '10 minutes',password_verified_at=password_verified_at-interval '6 minutes',expires_at=clock_timestamp()+interval '2 hours' WHERE family_id=$1", [original.familyId]);
    const before = (await pool().query("SELECT created_at,password_verified_at,expires_at FROM workspace_session_security WHERE family_id=$1", [original.familyId])).rows[0];
    // No step-up: the aged session applies the rename in one step.
    const initiallyApplied = await updateSettings(request("/api/settings", originalAccess, { name: "Unauthorized rename" }, "PATCH"));
    expect(initiallyApplied.status).toBe(200);
    expect((await pool().query("SELECT name FROM tenants WHERE id='source'")).rows[0].name).toBe("Unauthorized rename");
    const token = randomBytes(32).toString("base64url");
    await pool().query("INSERT INTO tenant_invitations(id,tenant_id,inviter_user_id,email,role,token_hash,expires_at) VALUES ('invitation','invited','inviter','invitee@example.test','admin',$1,clock_timestamp()+interval '1 hour')", [await hashToken(token)]);
    const accepted = await acceptInvitation(request("/api/team/invitations/accept", originalAccess, { token }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ sessionEstablished: true, tenantId: "invited" });
    const invitedAccess = cookie(accepted), invited = (await verifyWorkspaceToken(invitedAccess))!;
    expect(invited).toMatchObject({ tenantId: "invited", role: "admin" });
    const after = (await pool().query("SELECT created_at,password_verified_at,expires_at FROM workspace_session_security WHERE family_id=$1", [invited.familyId])).rows[0];
    expect.soft(after).toEqual(before);
    const switched = await selectTenant(request("/api/auth/select-tenant", invitedAccess, { tenantId: "source" }));
    expect(switched.status).toBe(200);
    const applied = await updateSettings(request("/api/settings", cookie(switched), { name: "Unauthorized rename" }, "PATCH"));
    expect.soft(applied.status).toBe(200);
    expect((await pool().query("SELECT name FROM tenants WHERE id='source'")).rows[0].name).toBe("Unauthorized rename");
    expect(await verifyWorkspaceToken(originalAccess)).toBeNull();
  });

  it.each(["logout", "password-reset"] as const)("%s while invitation waits prevents both membership and successor issuance", async change => {
    const current = await currentSession(), token = await invitation();
    const blocker = await pool().connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() n")).rows[0].n;
      await blocker.query("SELECT id FROM tenants WHERE id='invited' FOR UPDATE");
      pending = acceptInvitation(request("/api/team/invitations/accept", current.access, { token }));
      await waitForBlockedBy(pid);
      if (change === "logout") {
        expect((await logout(request("/api/auth/logout", current.access, {}))).status).toBe(200);
      } else {
        const resetToken = randomBytes(32).toString("base64url");
        await pool().query("INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES ('reset','invitee',$1,clock_timestamp()+interval '1 hour')", [await hashToken(resetToken)]);
        expect((await resetPassword(request("/api/auth/reset-password", "", { token: resetToken, password: "independent-new-password-84!" }))).status).toBe(200);
      }
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(401);
      await expectInvitationUntouched();
      expect(await verifyWorkspaceToken(current.access)).toBeNull();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("successor persistence failure rolls back invitation consumption, membership and source revocation together", async () => {
    const current = await currentSession(), token = await invitation();
    await pool().query("CREATE FUNCTION reject_invited_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='invited' THEN RAISE EXCEPTION 'synthetic successor persistence failure'; END IF; RETURN NEW; END $$");
    await pool().query("CREATE TRIGGER reject_invited_policy BEFORE INSERT ON workspace_session_security FOR EACH ROW EXECUTE FUNCTION reject_invited_policy()");
    try {
      const failed = await acceptInvitation(request("/api/team/invitations/accept", current.access, { token }));
      expect(failed.status).toBe(503);
      await expectInvitationUntouched();
      expect(await verifyWorkspaceToken(current.access)).not.toBeNull();
      expect((await pool().query("SELECT id FROM refresh_tokens WHERE user_id='invitee' AND revoked_at IS NULL")).rows.map(row => row.id)).toEqual([current.claims.sid]);
    } finally {
      await pool().query("DROP TRIGGER reject_invited_policy ON workspace_session_security");
      await pool().query("DROP FUNCTION reject_invited_policy()");
    }
  });
});
