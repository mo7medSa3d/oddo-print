import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as cutoverPOST } from "../src/app/api/odoo/installations/cutover/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("Odoo idempotency cutover locking", () => {
  let tenantId: string;
  let ownerToken: string;
  let memberToken: string;

  beforeAll(async () => { vi.stubEnv("GATEWAY_JWT_SECRET", "odoo-integration-auth-fixture-secret-32"); await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    const fixture = await seedFixture({ odooIdempotencyMode: "legacy" });
    tenantId = fixture.tenantId;
    // Separate principals: the manager authority guard serializes requests
    // made by the SAME user before they reach the tenant lock upgrade.
    ownerToken = (await createWorkspaceManagerTestSession(tenantId, { role: "owner" })).token;
    memberToken = (await createWorkspaceManagerTestSession(tenantId, { role: "admin" })).token;
  });
  afterAll(async () => { await closePool(); vi.unstubAllEnvs(); });

  it("serializes simultaneous managers instead of deadlocking shared tenant lock upgrades", async () => {
    const gate = await pool().connect();
    let committed = false;
    const inflight: Promise<Response>[] = [];
    const request = (token: string) => new Request("https://gateway.test/api/odoo/installations/cutover", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "strict_v2", verifiedExternalOutboxes: true,
        verifiedReceiptBackup: true, verifiedAllInstallationsEnrolled: true,
      }),
    });
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [tenantId]);
      for (const token of [ownerToken, memberToken]) {
        const pending = cutoverPOST(request(token));
        void pending.catch(() => undefined);
        inflight.push(pending);
      }
      // A third shared lock keeps both requests waiting for the exclusive
      // cutover lock. SHARE -> UPDATE would instead deadlock between them.
      await expect.poll(async () => {
        const rows = await pool().query(`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%odoo_idempotency_mode%'
            AND query LIKE '%FOR UPDATE%'
        `);
        return Number(rows.rows[0]?.count ?? 0);
      }, { timeout: 10_000, interval: 100 }).toBeGreaterThanOrEqual(2);
      await gate.query("COMMIT");
      committed = true;
      const results = await Promise.all(inflight);
      // No installation was enrolled: both correctly refuse the cutover;
      // neither operation may abort with PostgreSQL deadlock error 40P01.
      expect(results.map(response => response.status)).toEqual([409, 409]);
      for (const response of results) {
        expect(await response.json()).toMatchObject({ code: "MISSING_INSTALLATIONS" });
      }
      const mode = await pool().query("SELECT odoo_idempotency_mode FROM tenants WHERE id=$1", [tenantId]);
      expect(mode.rows[0]?.odoo_idempotency_mode).toBe("legacy");
    } finally {
      if (!committed) await gate.query("ROLLBACK");
      gate.release();
      await Promise.allSettled(inflight);
    }
  });
});
