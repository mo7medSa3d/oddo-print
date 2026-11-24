import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as billingStatusGET } from "../src/app/api/billing/status/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("workspace billing-status live authority fence", () => {
  let fixture: Fixture;
  let ownerToken: string;
  let memberToken: string;
  let ownerId: string;
  let familyId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "billing-availability-status-fence-secret-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const owner = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    const member = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "admin" });
    ownerToken = owner.token;
    memberToken = member.token;
    familyId = owner.familyId;
    ownerId = (await pool().query(
      "SELECT user_id FROM tenant_users WHERE tenant_id=$1 AND role='owner'",
      [fixture.tenantId],
    )).rows[0].user_id;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = (token: string) => new Request("https://gateway.test/api/billing/status", {
    headers: { authorization: `Bearer ${token}` },
  });

  it("shows commercial expiry only to the owner while retaining Full Access availability", async () => {
    const owner = await billingStatusGET(request(ownerToken));
    const member = await billingStatusGET(request(memberToken));
    expect([owner.status, member.status]).toEqual([200, 200]);
    expect(await owner.json()).toMatchObject({ hasSubscription: true, currentPeriodEnd: expect.any(String) });
    const memberBody = await member.json();
    expect(memberBody.hasSubscription).toBe(true);
    expect(memberBody).not.toHaveProperty("currentPeriodEnd");
  });

  it.each(["suspend", "revoke", "downgrade"] as const)(
    "does not reveal owner contract metadata after %s commits during a status read", async change => {
      const blocker = await pool().connect();
      let committed = false;
      let pending: Promise<Response> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
          fixture.tenantId, change === "suspend" ? "suspended" : "active",
        ]);
        const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = billingStatusGET(request(ownerToken));
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
          await pool().query(
            "UPDATE tenant_users SET role='admin' WHERE user_id=$1 AND tenant_id=$2",
            [ownerId, fixture.tenantId],
          );
        }
        await blocker.query("COMMIT");
        committed = true;
        const response = await pending;
        expect(response.status).toBe(change === "revoke" ? 401 : 403);
        const body = await response.json();
        expect(body).not.toHaveProperty("currentPeriodEnd");
        if (change === "suspend") expect(body).toMatchObject({ code: "TENANT_SUSPENDED" });
        if (change === "revoke") expect(body).toMatchObject({ code: "SESSION_EXPIRED" });
      } finally {
        if (!committed) await blocker.query("ROLLBACK");
        blocker.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
