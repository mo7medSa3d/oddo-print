import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as keysGET } from "../src/app/api/odoo/keys/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("Odoo API-key inventory live session and cache boundary", () => {
  let fixture: Fixture;
  let access: string;
  let familyId: string;
  let keyId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "odoo-key-list-fence-fixture-secret-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    access = session.token;
    familyId = session.familyId;
    keyId = (await pool().query("SELECT id FROM api_keys WHERE tenant_id=$1", [fixture.tenantId])).rows[0].id;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = () => new Request("https://gateway.test/api/odoo/keys", {
    headers: { authorization: `Bearer ${access}` },
  });

  it("returns only this workspace's key metadata with a private no-store response", async () => {
    const response = await keysGET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const list = await response.json();
    expect(list).toEqual([expect.objectContaining({ id: keyId })]);
    expect(JSON.stringify(list)).not.toContain(fixture.odooKey);
  });

  it.each(["suspend", "revoke"] as const)(
    "does not publish key IDs after %s commits between preflight and inventory read", async change => {
      const blocker = await pool().connect();
      let committed = false;
      let pending: Promise<Response> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
          fixture.tenantId, change === "suspend" ? "suspended" : "active",
        ]);
        const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = keysGET(request());
        void pending.catch(() => undefined);
        await expect.poll(async () => {
          const row = await pool().query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%FROM tenants%' AND query LIKE '%FOR SHARE%'
               AND $1=ANY(pg_blocking_pids(pid))`, [blockerPid],
          );
          return Number(row.rows[0]?.n ?? 0);
        }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);
        if (change === "revoke") {
          await pool().query("UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1", [familyId]);
        }
        await blocker.query("COMMIT");
        committed = true;
        const response = await pending;
        expect(response.status).toBe(change === "revoke" ? 401 : 403);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).not.toHaveProperty("id");
        expect(body).toMatchObject({ code: change === "revoke" ? "SESSION_EXPIRED" : "TENANT_SUSPENDED" });
      } finally {
        if (!committed) await blocker.query("ROLLBACK");
        blocker.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
