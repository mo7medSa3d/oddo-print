import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as workspaceSettings } from "../src/app/api/settings/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

describe.skipIf(!hasTestDatabase)("workspace settings current tenant and session authority", () => {
  let fixture: Fixture;
  let token: string;
  let familyId: string;
  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "settings-read-fence-fixture-secret-minimum-32");
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
  const request = () => new Request("https://gateway.test/api/settings", {
    headers: { authorization: `Bearer ${token}` },
  });

  async function raceSessionOrLifecycle(change: "suspend" | "revoke") {
    const writer = await pool().connect();
    let committed = false;
    let pending: Promise<Response> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
        fixture.tenantId, change === "suspend" ? "suspended" : "active",
      ]);
      const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending = workspaceSettings(request());
      void pending.catch(() => undefined);
      await expect.poll(async () => {
        const r = await pool().query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%FROM tenants%' AND query LIKE '%FOR SHARE%'
               AND $1=ANY(pg_blocking_pids(pid))`, [writerPid],
        );
        return Number(r.rows[0]?.n ?? 0);
      }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);
      if (change === "revoke") {
        await pool().query("UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1", [familyId]);
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

  it("returns only current workspace account metadata without caching", async () => {
    const response = await workspaceSettings(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.tenant.id).toBe(fixture.tenantId);
    expect(body.email).toContain("@");
    expect(body.role).toBe("owner");
  });

  it("does not disclose user email after concurrent workspace suspension", async () => {
    const response = await raceSessionOrLifecycle("suspend");
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ code: "TENANT_SUSPENDED" });
    expect(body).not.toHaveProperty("email");
  });

  it("does not disclose user email after concurrent session revocation", async () => {
    const response = await raceSessionOrLifecycle("revoke");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(body).not.toHaveProperty("email");
  });
});
