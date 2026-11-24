import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listMembers, DELETE as removeMember } from "../src/app/api/team/members/route";
import { verifyWorkspaceToken } from "../src/lib/manager-auth";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("workspace member directory live authority fence", () => {
  let fixture: Fixture;
  let access: string;
  let familyId: string;
  let ownerId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "directory-fence-fixture-secret-minimum-32");
    vi.stubEnv("APP_BASE_URL", "https://gateway.test");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    access = session.token;
    familyId = session.familyId;
    ownerId = (await verifyWorkspaceToken(access))!.userId!;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = () => new Request("https://gateway.test/api/team/members", {
    headers: { authorization: `Bearer ${access}` },
  });

  const removalRequest = (userId: string, token = access) => new Request(
    "https://gateway.test/api/team/members?userId=" + encodeURIComponent(userId), {
      method: "DELETE", headers: { authorization: `Bearer ${token}`, origin: "https://gateway.test" },
    },
  );

  async function memberWithAcceptedInvite() {
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "admin" });
    const userId = (await verifyWorkspaceToken(session.token))!.userId!;
    await pool().query(`INSERT INTO tenant_invitations
      (id,tenant_id,inviter_user_id,email,role,token_hash,expires_at,accepted_at)
      SELECT 'accepted-member-invite',$1,$2,email,'admin','accepted-member-hash',
        clock_timestamp()+interval '7 days',clock_timestamp() FROM users WHERE id=$3`,
    [fixture.tenantId, ownerId, userId]);
    return { ...session, userId };
  }

  async function blockedMemberRequest(change: "suspend" | "revoke") {
    const blocker = await pool().connect();
    let committed = false;
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
        fixture.tenantId, change === "suspend" ? "suspended" : "active",
      ]);
      const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending = listMembers(request());
      void pending.catch(() => undefined);

      // The member reader must reach a tenant FOR SHARE fence. The old
      // direct-list implementation responds with member emails without ever
      // waiting here after the initial (non-locking) session preflight.
      await expect.poll(async () => {
        const waiting = await pool().query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE '%FROM tenants%' AND query LIKE '%FOR SHARE%'
             AND $1 = ANY(pg_blocking_pids(pid))`, [blockerPid],
        );
        return Number(waiting.rows[0]?.n ?? 0);
      }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);

      if (change === "revoke") {
        await pool().query(
          "UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1",
          [familyId],
        );
      }
      await blocker.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
    }
  }

  it("lists only workspace members for an active owner session", async () => {
    const response = await listMembers(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.members).toEqual(expect.arrayContaining([expect.objectContaining({
      role: "owner",
    })]));
  });

  it("does not expose member emails after tenant suspension commits during authentication", async () => {
    const response = await blockedMemberRequest("suspend");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("does not expose member emails after its authenticated session is revoked", async () => {
    const response = await blockedMemberRequest("revoke");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("removes an accepted invitee, revokes their access and records the workspace owner", async () => {
    const member = await memberWithAcceptedInvite();
    const directory = await listMembers(request());
    expect(directory.status).toBe(200);
    expect((await directory.json()).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: member.userId, removableByCurrentOwner: true }),
      expect.objectContaining({ userId: ownerId, removableByCurrentOwner: false }),
    ]));
    const crossSite = await removeMember(new Request(removalRequest(member.userId), {
      headers: { authorization: `Bearer ${access}`, origin: "https://other.test" },
    }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: "INVALID_ORIGIN" });
    const removed = await removeMember(removalRequest(member.userId));
    expect(removed.status).toBe(200);
    expect((await pool().query("SELECT 1 FROM tenant_users WHERE tenant_id=$1 AND user_id=$2",
      [fixture.tenantId, member.userId])).rows).toHaveLength(0);
    expect((await pool().query("SELECT 1 FROM users WHERE id=$1", [member.userId])).rows).toHaveLength(1);
    const revoked = await pool().query("SELECT revoked_at FROM refresh_tokens WHERE family_id=$1", [member.familyId]);
    expect(revoked.rows.length).toBeGreaterThan(0);
    expect(revoked.rows.every(row => row.revoked_at !== null)).toBe(true);
    const formerMember = await listMembers(new Request("https://gateway.test/api/team/members", {
      headers: { authorization: `Bearer ${member.token}` },
    }));
    expect(formerMember.status).toBe(401);
    expect((await pool().query("SELECT actor_type,actor_id,resource_id FROM audit_events WHERE action='team.member.removed'"))
      .rows).toEqual([{ actor_type: "user", actor_id: ownerId, resource_id: member.userId }]);
  });

  it("protects the workspace owner and members the owner did not invite", async () => {
    const member = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "admin" });
    const userId = (await verifyWorkspaceToken(member.token))!.userId!;
    const uninvited = await removeMember(removalRequest(userId));
    expect(uninvited.status).toBe(403);
    expect(await uninvited.json()).toMatchObject({ code: "MEMBER_NOT_REMOVABLE" });
    const owner = await removeMember(removalRequest(ownerId));
    expect(owner.status).toBe(409);
    expect(await owner.json()).toMatchObject({ code: "TRANSFER_OWNER_FIRST" });
    expect((await removeMember(removalRequest(ownerId, member.token))).status).toBe(403);
  });

  it("rejects another tenant's member and a revoked owner session", async () => {
    const other = await seedFixture();
    const outside = await createWorkspaceManagerTestSession(other.tenantId, { role: "owner" });
    const outsideId = (await verifyWorkspaceToken(outside.token))!.userId!;
    expect((await removeMember(removalRequest(outsideId))).status).toBe(404);
    const invited = await memberWithAcceptedInvite();
    await pool().query("UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1", [familyId]);
    expect((await removeMember(removalRequest(invited.userId))).status).toBe(401);
    expect((await pool().query("SELECT 1 FROM tenant_users WHERE tenant_id=$1 AND user_id=$2",
      [fixture.tenantId, invited.userId])).rows).toHaveLength(1);
  });
});
