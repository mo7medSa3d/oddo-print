import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listInvitations, POST as createInvitation, DELETE as revokeInvitation } from "../src/app/api/team/invitations/route";
import { verifyWorkspaceToken } from "../src/lib/manager-auth";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";
import type * as EmailModule from "../src/lib/email";

// Preserve real workspace-origin validation, authorizations and transactional
// audit writes. Only the outbound email provider is external.
vi.mock("../src/lib/email", async original => ({
  ...await original<typeof EmailModule>(),
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

describe.skipIf(!hasTestDatabase)("workspace invitation audit actor provenance", () => {
  let fixture: Fixture;
  let token: string;
  let ownerId: string;
  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "invite-audit-actor-fixture-secret-minimum-32");
    vi.stubEnv("APP_BASE_URL", "https://gateway.test");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    token = session.token;
    const claims = await verifyWorkspaceToken(token);
    if (!claims?.userId) throw new Error("Expected a live workspace owner");
    ownerId = claims.userId;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  it("attributes invite creation/revocation to the verified workspace user, never to global Platform Owner", async () => {
    const origin = "https://gateway.test";
    const created = await createInvitation(new Request(origin + "/api/team/invitations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "colleague@example.test" }),
    }));
    expect(created.status).toBe(201);
    const createBody = await created.json() as { id: string };
    expect(createBody.id).toMatch(/^inv_/);
    const listed = await listInvitations(new Request(origin + "/api/team/invitations", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(listed.status).toBe(200);
    expect((await listed.json()).invitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: createBody.id, email: "colleague@example.test" }),
    ]));

    const revoked = await revokeInvitation(new Request(origin + "/api/team/invitations?id=" + encodeURIComponent(createBody.id), {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, origin },
    }));
    expect(revoked.status).toBe(200);
    const events = await pool().query(
      `SELECT tenant_id, actor_type, actor_id, action, resource_id FROM audit_events
       WHERE action IN ('team.invitation.created','team.invitation.revoked')
       ORDER BY created_at, id`,
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.map(row => row.action).sort()).toEqual(["team.invitation.created", "team.invitation.revoked"]);
    for (const row of events.rows) {
      expect(row).toMatchObject({
        tenant_id: fixture.tenantId,
        actor_type: "user",
        actor_id: ownerId,
        resource_id: createBody.id,
      });
    }
    const saved = await pool().query("SELECT tenant_id, revoked_at FROM tenant_invitations WHERE id=$1", [createBody.id]);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0].tenant_id).toBe(fixture.tenantId);
    expect(saved.rows[0].revoked_at).not.toBeNull();
  });
});
