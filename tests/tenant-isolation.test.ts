import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../src/db";
import { printJobs } from "../src/db/schema";
import { claimJobForDelivery } from "../src/lib/job-delivery";
import { createPrintJobForPrinter } from "../src/lib/print-job-service";
import { hasTestDatabase, applyMigrations, truncateAll, closePool, pool, seedFixture, insertQueuedJob } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function authRequest(url: string, apiKey: string, init?: RequestInit): Request {
  return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${apiKey}` } });
}

suite("Tenant Isolation Invariants (Negative Tests)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("Test 1: API Key B cannot read Tenant A printers", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const { GET } = await import("../src/app/api/odoo/printers/route");

    const response = await GET(authRequest(`http://gateway.test/api/odoo/printers?agent_id=${encodeURIComponent(a.agentId)}`, b.odooKey));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.printers).toEqual([]);
  });

  it("Test 2: API Key B cannot dispatch a job to Tenant A printer", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const { POST } = await import("../src/app/api/print/jobs/route");

    const response = await POST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${b.odooKey}`, "Content-Type": "application/json", "Content-Length": "200" },
      body: JSON.stringify({
        printerId: a.printerId,
        documentType: "receipt",
        destination: b.destination,
        payload: { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" },
      }),
    }));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/not found|not authorized/i);
  });

  it("Test 3: Agent B cannot claim Tenant A job", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const jobId = `job_${a.tenantId}`;
    await insertQueuedJob(a, jobId);

    const claimed = await claimJobForDelivery(jobId, b.agentId);
    expect(claimed).toBeNull();
    const row = await pool().query("SELECT status, tenant_id, agent_id FROM print_jobs WHERE id = $1", [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "queued", tenant_id: a.tenantId, agent_id: a.agentId });
  });

  it("Test 4: Tenant print-job admission remains tenant-scoped", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const payload = { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" } as const;

    const jobA = await createPrintJobForPrinter(a.printerId, payload, {
      tenantId: a.tenantId,
      requestedBy: "tenant-a-test",
      documentType: "receipt",
      destination: a.destination,
      idempotencyKey: `tenant-a-${a.tenantId}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const jobB = await createPrintJobForPrinter(b.printerId, payload, {
      tenantId: b.tenantId,
      requestedBy: "tenant-b-test",
      documentType: "receipt",
      destination: b.destination,
      idempotencyKey: `tenant-b-${b.tenantId}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(jobA.id).not.toBe(jobB.id);
    const rows = await pool().query(
      "SELECT tenant_id, COUNT(*)::int AS count FROM print_jobs GROUP BY tenant_id ORDER BY tenant_id",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r: any) => r.count === 1)).toBe(true);
  });

  it("linearizes tenant suspension and print-job admission", async () => {
    await truncateAll();
    const f = await seedFixture();
    const payload = { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" } as const;
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [f.tenantId]);

      const creating = createPrintJobForPrinter(f.printerId, payload, {
        tenantId: f.tenantId,
        requestedBy: "tenant-suspension-race",
        documentType: "receipt",
        destination: f.destination,
        idempotencyKey: "tenant-suspension-race-" + f.tenantId,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.query(
        "UPDATE tenants SET lifecycle = 'suspended', lifecycle_reason = 'Concurrent suspension test', suspended_at = clock_timestamp() WHERE id = $1",
        [f.tenantId],
      );
      await client.query("COMMIT");

      await expect(creating).rejects.toMatchObject({ code: "TENANT_UNAVAILABLE" });
      const rows = await pool().query("SELECT count(*)::int AS count FROM print_jobs WHERE tenant_id = $1", [f.tenantId]);
      expect(rows.rows[0].count).toBe(0);
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
  });
  it("Test 5: WebSocket/job-delivery ownership cannot cross Agent tenants", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const jobId = `job_ws_${a.tenantId}`;
    await insertQueuedJob(a, jobId);

    const bClaim = await claimJobForDelivery(jobId, b.agentId);
    expect(bClaim).toBeNull();

    const ownership = await pool().query(
      `SELECT count(*)::int AS count
       FROM print_jobs p
       JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
       JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
       WHERE p.id = $1 AND a.tenant_id = $2`,
      [jobId, b.tenantId],
    );
    expect(ownership.rows[0].count).toBe(0);
  });

  it("Test 7: Composite ownership FKs reject cross-tenant runtime relationships", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();

    await expect(pool().query(
      `INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle)
       VALUES ($1, $2, $3, 'Cross Tenant Printer', 'physical', 'other', 'network', 'raw', 'offline', 'active')`,
      [`printer_cross_${a.tenantId}`, a.tenantId, b.agentId],
    )).rejects.toBeDefined();

    await expect(pool().query(
      `INSERT INTO discovery_sessions (id, tenant_id, agent_id, status) VALUES ($1, $2, $3, 'running')`,
      [`discovery_cross_${a.tenantId}`, a.tenantId, b.agentId],
    )).rejects.toBeDefined();
  });

  it("Test 8: Composite ownership FK rejects a cross-tenant job event", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const jobId = `job_event_fk_${a.tenantId}`;
    await insertQueuedJob(a, jobId);

    await expect(
      pool().query(
        `INSERT INTO job_events (id, tenant_id, job_id, stage, status)
         VALUES ($1, $2, $3, 'queued', 'ok')`,
        [`evt_cross_${a.tenantId}`, b.tenantId, jobId],
      ),
    ).rejects.toBeDefined();

    const exists = await pool().query(
      "SELECT count(*)::int AS count FROM job_events WHERE id = $1",
      [`evt_cross_${a.tenantId}`],
    );
    expect(exists.rows[0].count).toBe(0);
  });

  it("Test 6: Composite ownership FK rejects a cross-tenant job", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();
    const jobId = `job_fk_${a.tenantId}`;

    await expect(
      db.insert(printJobs).values({
        id: jobId,
        tenantId: a.tenantId,
        destination: a.destination,
        documentType: "receipt",
        agentId: a.agentId,
        printerId: b.printerId,
        status: "queued",
        payload: { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" },
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toBeDefined();

    const exists = await pool().query("SELECT count(*)::int AS count FROM print_jobs WHERE id = $1", [jobId]);
    expect(exists.rows[0].count).toBe(0);
  });
});
