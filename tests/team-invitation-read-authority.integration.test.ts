import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listInvitations } from "../src/app/api/team/invitations/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

describe.skipIf(!hasTestDatabase)("workspace invitation directory live authority", () => {
  let fixture: Fixture;
  let token: string;
  let familyId: string;
  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "invitation-read-fence-fixture-secret-minimum-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    token = session.token;
    familyId = session.familyId;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = () => new Request("https://gateway.test/api/team/invitations?limit=50", {
    headers: { authorization: `Bearer ${token}` },
  });

  async function raceLifecycle(change: "suspend" | "revoke") {
    const writer = await pool().connect();
    let committed = false;
    let pending: Promise<Response> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
        fixture.tenantId, change === "suspend" ? "suspended" : "active",
      ]);
      const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending = listInvitations(request());
      void pending.catch(() => undefined);
      // A read cannot leak pending invitee email addresses while the
      // authoritative tenant mutation is in progress.
      await expect.poll(async () => {
        const rows = await pool().query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%FROM tenants%' AND query LIKE '%FOR SHARE%'
              AND $1=ANY(pg_blocking_pids(pid))`, [writerPid],
        );
        return Number(rows.rows[0]?.n ?? 0);
      }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);
      if (change === "revoke") {
        await pool().query(
          "UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1",
          [familyId],
        );
      }
      await writer.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      if (!committed) await writer.query("ROLLBACK");
      writer.release();
      await pending?.catch(() => undefined);
    }
  }

  it("returns a tenant-scoped and uncacheable invitation list to a current verified owner", async () => {
    const response = await listInvitations(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ invitations: [], limit: 50, total: 0 });
  });

  it("denies invitation email disclosure if tenant suspension commits during preflight", async () => {
    const response = await raceLifecycle("suspend");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("denies invitation email disclosure if session revocation races with preflight", async () => {
    const response = await raceLifecycle("revoke");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_EXPIRED" });
  });
});
