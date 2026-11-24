import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool as gatewayPool } from "../src/db";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("database runtime state constraints", () => {
  let f: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
    await gatewayPool.end();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  async function expectRejected(sqlText: string, values: unknown[]) {
    await expect(pool().query(sqlText, values)).rejects.toMatchObject({ code: "23514" });
  }

  it("rejects invalid agent status", async () => {
    await expectRejected(`UPDATE agents SET status = 'bogus' WHERE id = $1`, [f.agentId]);
  });

  it("expires a stalled transaction and releases its locks within the production idle budget", async () => {
    const holder = await gatewayPool.connect();
    let released = false;
    try {
      const setting = await holder.query("SHOW idle_in_transaction_session_timeout");
      expect(setting.rows[0].idle_in_transaction_session_timeout).toBe("30s");
      const lock = 2140000000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<Error & { code?: string }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Stalled transaction survived its idle budget")), 35_000);
        holder.once("error", (error: Error & { code?: string }) => { clearTimeout(timer); resolve(error); });
      });
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1)", [lock]);
        expect((await pool().query("SELECT pg_try_advisory_xact_lock($1) AS available", [lock])).rows[0].available).toBe(false);
        const error = await expired;
        expect(error.code).toBe("25P03");
        expect((await pool().query("SELECT pg_try_advisory_xact_lock($1) AS available", [lock])).rows[0].available).toBe(true);
        holder.release(true); released = true;
        expect((await gatewayPool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
      } finally { clearTimeout(timer); }
    } finally {
      if (!released) {
        try { await holder.query("ROLLBACK"); } catch { /* timed-out connection */ }
        holder.release(true);
      }
    }
  }, 40_000);

  it("rejects invalid printer status", async () => {
    await expectRejected(`UPDATE printers SET status = 'bogus' WHERE id = $1`, [f.printerId]);
  });

  it("rejects invalid print job status and negative counters", async () => {
    const id = `job_constraint_${Date.now()}_1`;
    await expectRejected(`INSERT INTO print_jobs (id, tenant_id, destination, document_type, agent_id, printer_id, status, payload, expires_at)
      VALUES ($1, $2, $3, 'invoice', $4, $5, 'bogus', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour')`,
      [id, f.tenantId, f.destination, f.agentId, f.printerId]);

    const validId = `job_constraint_${Date.now()}_2`;
    await pool().query(`INSERT INTO print_jobs (id, tenant_id, destination, document_type, agent_id, printer_id, status, payload, expires_at)
      VALUES ($1, $2, $3, 'invoice', $4, $5, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour')`,
      [validId, f.tenantId, f.destination, f.agentId, f.printerId]);
    await expectRejected(`UPDATE print_jobs SET retries = -1 WHERE id = $1`, [validId]);
    await expectRejected(`UPDATE print_jobs SET delivery_attempts = -1 WHERE id = $1`, [validId]);
  });

  it("enforces tenant-scoped print-job idempotency uniqueness", async () => {
    const key = `idempotent_${Date.now()}`;
    const apiKeyId = `key_${Date.now()}`;
    await pool().query(`INSERT INTO api_keys (id, tenant_id, name, hashed_key)
      VALUES ($1, $2, 'constraint key', $3)`, [apiKeyId, f.tenantId, apiKeyId]);

    await pool().query(`INSERT INTO print_jobs (id, tenant_id, api_key_id, destination, document_type, agent_id, printer_id, status, payload, expires_at, idempotency_key)
      VALUES ($1, $2, $3, $4, 'invoice', $5, $6, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour', $7)`,
      [`job_constraint_${Date.now()}_3`, f.tenantId, apiKeyId, f.destination, f.agentId, f.printerId, key]);

    await expect(pool().query(`INSERT INTO print_jobs (id, tenant_id, api_key_id, destination, document_type, agent_id, printer_id, status, payload, expires_at, idempotency_key)
      VALUES ($1, $2, $3, $4, 'invoice', $5, $6, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour', $7)`,
      [`job_constraint_${Date.now()}_4`, f.tenantId, apiKeyId, f.destination, f.agentId, f.printerId, key])).rejects.toMatchObject({ code: "23505" });

    const otherApiKeyId = `key_other_${Date.now()}`;
    await pool().query(`INSERT INTO api_keys (id, tenant_id, name, hashed_key)
      VALUES ($1, $2, 'other constraint key', $3)`, [otherApiKeyId, f.tenantId, otherApiKeyId]);
    await expect(pool().query(`INSERT INTO print_jobs (id, tenant_id, api_key_id, destination, document_type, agent_id, printer_id, status, payload, expires_at, idempotency_key)
      VALUES ($1, $2, $3, $4, 'invoice', $5, $6, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour', $7)`,
      [`job_constraint_${Date.now()}_5`, f.tenantId, otherApiKeyId, f.destination, f.agentId, f.printerId, key])).rejects.toMatchObject({ code: "23505" });
  });
});
