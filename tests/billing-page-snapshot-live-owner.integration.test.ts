import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOwnerBillingPageSnapshot } from "../src/lib/billing-page-snapshot";
import { verifyWorkspaceTokenFromCookieValues, type ManagerClaims } from "../src/lib/manager-auth";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

describe.skipIf(!hasTestDatabase)("server-rendered billing snapshot authorization", () => {
  let fixture: Fixture, claims: ManagerClaims, familyId: string, ownerId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "billing-ssr-authority-fence-test-secret-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const owner = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    familyId = owner.familyId;
    const verified = await verifyWorkspaceTokenFromCookieValues(null, owner.token);
    if (!verified) throw new Error("Owner fixture could not authenticate");
    claims = verified;
    ownerId = claims.userId!;
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  it("loads the current owner contract and monthly usage as one authorized snapshot", async () => {
    const result = await loadOwnerBillingPageSnapshot(claims);
    expect(result.sub?.status).toBe("active");
    expect(result.plan?.name).toBeTruthy();
    expect(result.requests).toEqual([]);
    expect(result.usage).toMatchObject({ used: 0, limit: "unlimited", remaining: "unlimited" });
  });

  it.each(["suspend", "revoke", "downgrade"] as const)(
    "denies commercial SSR data if %s commits while the reader waits for its tenant fence", async change => {
      const gate = await pool().connect();
      let committed = false;
      let pending: Promise<unknown> | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
          fixture.tenantId, change === "suspend" ? "suspended" : "active",
        ]);
        const blockerPid = Number((await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = loadOwnerBillingPageSnapshot(claims);
        void pending.catch(() => undefined);
        await expect.poll(async () => {
          const result = await pool().query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%FROM tenants%' AND query LIKE '%FOR SHARE%'
               AND $1=ANY(pg_blocking_pids(pid))`, [blockerPid],
          );
          return Number(result.rows[0]?.n ?? 0);
        }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);
        if (change === "revoke") {
          await pool().query("UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1", [familyId]);
        } else if (change === "downgrade") {
          await pool().query("UPDATE tenant_users SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [fixture.tenantId, ownerId]);
        }
        await gate.query("COMMIT");
        committed = true;
        await expect(pending).rejects.toMatchObject({
          code: change === "suspend" ? "TENANT_SUSPENDED" : change === "revoke" ? "SESSION_EXPIRED" : "WORKSPACE_AUTHORITY_CHANGED",
        });
      } finally {
        if (!committed) await gate.query("ROLLBACK");
        gate.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
