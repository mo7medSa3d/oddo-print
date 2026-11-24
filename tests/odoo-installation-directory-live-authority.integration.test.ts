import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as installationsGET } from "../src/app/api/odoo/installations/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("Odoo installation inventory requires live workspace authority", () => {
  let fixture: Fixture;
  let access: string;
  let familyId: string;
  let installationId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "odoo-inventory-fence-fixture-secret-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture({ odooIdempotencyMode: "strict_v2" });
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    access = session.token;
    familyId = session.familyId;
    installationId = randomUUID();
    const keyId = (await pool().query("SELECT id FROM api_keys WHERE tenant_id=$1", [fixture.tenantId])).rows[0].id;
    await pool().query(
      "INSERT INTO odoo_installations(id,tenant_id,name,secret_hash) VALUES ($1,$2,$3,$4)",
      [installationId, fixture.tenantId, "Private accounting deployment", "a".repeat(64)],
    );
    await pool().query(
      "INSERT INTO odoo_installation_credentials(tenant_id,installation_id,api_key_id) VALUES ($1,$2,$3)",
      [fixture.tenantId, installationId, keyId],
    );
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = () => new Request("https://gateway.test/api/odoo/installations", {
    headers: { authorization: `Bearer ${access}` },
  });

  it("lists the authorized workspace installation without exposing its proof", async () => {
    const response = await installationsGET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json();
    expect(body).toEqual([expect.objectContaining({
      id: installationId, name: "Private accounting deployment",
    })]);
    expect(JSON.stringify(body)).not.toContain("a".repeat(64));
  });

  it.each(["suspend", "revoke"] as const)(
    "denies the inventory when %s commits after initial request authentication", async change => {
      const blocker = await pool().connect();
      let committed = false;
      let pending: Promise<Response> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
          fixture.tenantId, change === "suspend" ? "suspended" : "active",
        ]);
        const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = installationsGET(request());
        void pending.catch(() => undefined);
        // The stale endpoint returned private installation/key IDs before
        // waiting on the tenant lock. All authenticated inventory must recheck
        // tenant lifecycle and session authority in the same read transaction.
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
          await pool().query(
            "UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1",
            [familyId],
          );
        }
        await blocker.query("COMMIT");
        committed = true;
        const response = await pending;
        expect(response.status).toBe(change === "suspend" ? 403 : 401);
        expect(await response.json()).toMatchObject({
          code: change === "suspend" ? "TENANT_SUSPENDED" : "SESSION_EXPIRED",
        });
      } finally {
        if (!committed) await blocker.query("ROLLBACK");
        blocker.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
