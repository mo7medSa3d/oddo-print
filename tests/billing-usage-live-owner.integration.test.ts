import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as usageGET } from "../src/app/api/billing/usage/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("owner-only billing usage must recheck active tenant and session", () => {
  let fixture: Fixture;
  let access: string;
  let familyId: string;
  let userId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "billing-usage-owner-fence-secret-min-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const owner = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    access = owner.token;
    familyId = owner.familyId;
    userId = (await pool().query("SELECT user_id FROM tenant_users WHERE tenant_id=$1 AND role='owner'", [fixture.tenantId])).rows[0].user_id;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = () => new Request("https://gateway.test/api/billing/usage", {
    headers: { authorization: `Bearer ${access}` },
  });

  it("returns a private owner-only usage snapshot with no credentials", async () => {
    const response = await usageGET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.plan.id).toBeTruthy();
    expect(body.resources.prints).toMatchObject({ used: 0, remaining: "unlimited" });
    expect(JSON.stringify(body)).not.toContain(fixture.odooKey);
  });

  it.each(["suspend", "revoke", "downgrade"] as const)(
    "denies commercial usage when %s commits after HTTP preflight", async change => {
      const gate = await pool().connect();
      let committed = false;
      let pending: Promise<Response> | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
          fixture.tenantId, change === "suspend" ? "suspended" : "active",
        ]);
        const blockerPid = Number((await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = usageGET(request());
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
        } else if (change === "downgrade") {
          await pool().query("UPDATE tenant_users SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [fixture.tenantId, userId]);
        }
        await gate.query("COMMIT");
        committed = true;
        const response = await pending;
        expect(response.status).toBe(change === "revoke" ? 401 : 403);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).not.toHaveProperty("resources");
        if (change === "suspend") expect(body).toMatchObject({ code: "TENANT_SUSPENDED" });
        if (change === "revoke") expect(body).toMatchObject({ code: "SESSION_EXPIRED" });
      } finally {
        if (!committed) await gate.query("ROLLBACK");
        gate.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
