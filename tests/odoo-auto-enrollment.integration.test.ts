import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { POST as enroll } from "../src/app/api/odoo/installations/auto/route";
import { applyMigrations, closePool, hasTestDatabase, insertQueuedJob, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";
import { makeV2OdooKey } from "../src/lib/odoo-idempotency";

const suite = describe.skipIf(!hasTestDatabase);

function attempt(apiKey: string, installationId: string, installationProof: string) {
  return enroll(new Request("https://gateway.test/api/odoo/installations/auto", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ installationId, installationProof, name: "Automatic Odoo" }),
  }));
}

function credentials() {
  return { id: randomUUID(), proof: randomBytes(32).toString("base64url") };
}

suite("zero-touch Odoo installation enrollment (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture({ odooIdempotencyMode: "strict_v2" });
  });

  it("fresh tenant schema default is strict_v2 without any migration input", async () => {
    const freshId = "tenant_default_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const response = await pool().query(
      "INSERT INTO tenants (id, name) VALUES ($1, $2) RETURNING odoo_idempotency_mode AS mode",
      [freshId, "New tenant strict-v2 default"],
    );
    expect(response.rows[0].mode).toBe("strict_v2");
  });

  it("registers a fresh strict-v2 tenant without customer cutover input", async () => {
    const who = credentials();
    const original = await pool().query("SELECT odoo_idempotency_mode AS mode FROM tenants WHERE id=$1", [fixture.tenantId]);
    expect(original.rows[0].mode).toBe("strict_v2");
    const created = await attempt(fixture.odooKey, who.id, who.proof);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ installationId: who.id, idempotencyVersion: 2, state: "created" });
    const state = await pool().query("SELECT odoo_idempotency_mode AS mode FROM tenants WHERE id=$1", [fixture.tenantId]);
    expect(state.rows[0].mode).toBe("strict_v2");
    const repeat = await attempt(fixture.odooKey, who.id, who.proof);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ installationId: who.id, idempotencyVersion: 2, state: "existing" });
    const rows = await pool().query("SELECT secret_hash FROM odoo_installations WHERE id=$1", [who.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].secret_hash).not.toContain(who.proof);
  });

  it("enrolls multiple independent Odoo databases using one API key without colliding", async () => {
    const a = credentials();
    const b = credentials();
    const results = await Promise.all([attempt(fixture.odooKey, a.id, a.proof), attempt(fixture.odooKey, b.id, b.proof)]);
    expect(results.map((response) => response.status)).toEqual([201, 201]);
    expect(makeV2OdooKey(a.id, "1", "receipt-100"))
      .not.toBe(makeV2OdooKey(b.id, "1", "receipt-100"));
    const associated = await pool().query("SELECT installation_id FROM odoo_installation_credentials WHERE tenant_id=$1 ORDER BY installation_id", [fixture.tenantId]);
    expect(associated.rows.map((row) => row.installation_id).sort()).toEqual([a.id,b.id].sort());
  });

  it("rejects a copied or wrong proof without modifying the registered owner", async () => {
    const a = credentials();
    const b = credentials();
    expect((await attempt(fixture.odooKey, a.id, a.proof)).status).toBe(201);
    const bad = await attempt(fixture.odooKey, a.id, b.proof);
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ code: "INSTALLATION_OWNERSHIP_CONFLICT" });
    const repeat = await attempt(fixture.odooKey, a.id, a.proof);
    expect(repeat.status).toBe(200);
  });

  it("does not infer permission to cut over an empty legacy workspace from absent Gateway history", async () => {
    await pool().query("UPDATE tenants SET odoo_idempotency_mode = 'legacy' WHERE id=$1", [fixture.tenantId]);
    const identity = credentials();
    const response = await attempt(fixture.odooKey, identity.id, identity.proof);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const mode = await pool().query("SELECT odoo_idempotency_mode AS mode FROM tenants WHERE id=$1", [fixture.tenantId]);
    expect(mode.rows[0].mode).toBe("legacy");
    expect((await pool().query("SELECT id FROM odoo_installations WHERE tenant_id=$1", [fixture.tenantId])).rows).toEqual([]);
  });

  it("refuses automatic enrollment for an existing legacy tenant with prior Odoo jobs", async () => {
    await pool().query("UPDATE tenants SET odoo_idempotency_mode = 'legacy' WHERE id=$1", [fixture.tenantId]);
    const jobId = "legacy_auto_enrollment_history";
    await insertQueuedJob(fixture, jobId);
    const key = await pool().query("SELECT id FROM api_keys WHERE tenant_id=$1", [fixture.tenantId]);
    await pool().query("UPDATE print_jobs SET api_key_id=$1 WHERE id=$2", [key.rows[0].id, jobId]);
    const a = credentials();
    const response = await attempt(fixture.odooKey, a.id, a.proof);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    const mode = await pool().query("SELECT odoo_idempotency_mode AS mode FROM tenants WHERE id=$1", [fixture.tenantId]);
    expect(mode.rows[0].mode).toBe("legacy");
    const associations = await pool().query("SELECT id FROM odoo_installations WHERE tenant_id=$1", [fixture.tenantId]);
    expect(associations.rows).toHaveLength(0);
  });

  it("rejects a credential hash replaced while the tenant lock is held", async () => {
    const identity = credentials();
    const blocker = await pool().connect();
    let committed = false;
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE tenants SET lifecycle='active' WHERE id=$1", [fixture.tenantId]);
      const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending = attempt(fixture.odooKey, identity.id, identity.proof);
      void pending.catch(() => undefined);
      // Initial key authentication is allowed to finish before the locked
      // tenant cutover check. The tx must then match the CURRENT key hash.
      await expect.poll(async () => {
        const rows = await pool().query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM tenants%' AND query LIKE '%FOR UPDATE%' AND $1=ANY(pg_blocking_pids(pid))",
          [blockerPid],
        );
        return Number(rows.rows[0]?.n ?? 0);
      }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);
      await pool().query("UPDATE api_keys SET hashed_key=$1 WHERE tenant_id=$2", ["f".repeat(64), fixture.tenantId]);
      await blocker.query("COMMIT");
      committed = true;
      const response = await pending;
      expect(response.status).toBe(401);
      const installations = await pool().query("SELECT id FROM odoo_installations WHERE tenant_id=$1", [fixture.tenantId]);
      expect(installations.rows).toEqual([]);
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
    }
  });

  it("does not activate a workspace with a suspended manual subscription", async () => {
    await pool().query("UPDATE tenant_subscriptions SET status='suspended' WHERE tenant_id=$1", [fixture.tenantId]);
    const a = credentials();
    const response = await attempt(fixture.odooKey, a.id, a.proof);
    expect(response.status).toBe(403);
    const mode = await pool().query("SELECT odoo_idempotency_mode AS mode FROM tenants WHERE id=$1", [fixture.tenantId]);
    expect(mode.rows[0].mode).toBe("strict_v2");
  });
});
