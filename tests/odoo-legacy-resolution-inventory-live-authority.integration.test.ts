import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as resolutionGET } from "../src/app/api/odoo/installations/resolutions/route";
import { makeLegacyOdooKey } from "../src/lib/odoo-idempotency";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, insertQueuedJob, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("legacy reconciliation preview needs a live tenant/session", () => {
  let fixture: Fixture;
  let ownerToken: string;
  let familyId: string;
  let installationId: string;

  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "legacy-resolution-preview-fence-secret-32");
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture({ odooIdempotencyMode: "legacy" });
    const session = await createWorkspaceManagerTestSession(fixture.tenantId, { role: "owner" });
    ownerToken = session.token;
    familyId = session.familyId;
    installationId = randomUUID();
    await pool().query(
      "INSERT INTO odoo_installations(id,tenant_id,name,secret_hash) VALUES($1,$2,$3,$4)",
      [installationId, fixture.tenantId, "Historical receipt reconciliation", "c".repeat(64)],
    );
  });
  afterAll(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  const request = () => new Request(
    `https://gateway.test/api/odoo/installations/resolutions?installationId=${installationId}&sourceCompanyId=1&sourceOperationId=original-receipt`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );

  it("returns the scoped reconciliation preview without disclosing the external proof", async () => {
    const response = await resolutionGET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.installationId).toBe(installationId);
    expect(body.history).toBeNull();
    expect(body.resolution).toBeNull();
    expect(JSON.stringify(body)).not.toContain("c".repeat(64));
  });

  it("does not block a read-only preview behind a concurrent historical row update", async () => {
    const historicalId = "legacy_preview_update_race";
    await insertQueuedJob(fixture, historicalId);
    const legacyKey = makeLegacyOdooKey("1", "original-receipt");
    const keyId = (await pool().query("SELECT id FROM api_keys WHERE tenant_id=$1", [fixture.tenantId])).rows[0].id;
    await pool().query(
      "UPDATE print_jobs SET api_key_id=$1,idempotency_key=$2 WHERE id=$3",
      [keyId, legacyKey, historicalId],
    );
    const blocker = await pool().connect();
    let pending: Promise<Response> | undefined;
    let finished = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE print_jobs SET updated_at=clock_timestamp() WHERE id=$1",
        [historicalId],
      );
      pending = resolutionGET(request()).then(response => {
        finished = true;
        return response;
      });
      void pending.catch(() => undefined);
      // Preview must read a stable committed version, not lock historical
      // print job rows. POST reconciliation still takes FOR UPDATE and
      // revalidates the exact fingerprint/receipt before altering anything.
      await expect.poll(() => finished, { timeout: 2_500, interval: 50 }).toBe(true);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        history: { id: historicalId, status: "queued" },
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
    }
  });

  it.each(["suspend", "revoke"] as const)(
    "does not expose historical receipt IDs when %s commits after preflight", async change => {
      const gate = await pool().connect();
      let committed = false;
      let pending: Promise<Response> | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query("UPDATE tenants SET lifecycle=$2 WHERE id=$1", [
          fixture.tenantId, change === "suspend" ? "suspended" : "active",
        ]);
        const blockerPid = Number((await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = resolutionGET(request());
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
          await pool().query(
            "UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1",
            [familyId],
          );
        }
        await gate.query("COMMIT");
        committed = true;
        const response = await pending;
        expect(response.status).toBe(change === "suspend" ? 403 : 401);
        const body = await response.json();
        expect(body).not.toHaveProperty("history");
        expect(body).not.toHaveProperty("resolution");
        expect(body).toMatchObject({
          code: change === "suspend" ? "TENANT_SUSPENDED" : "SESSION_EXPIRED",
        });
      } finally {
        if (!committed) await gate.query("ROLLBACK");
        gate.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
