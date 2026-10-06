import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { cleanupTerminalPrintJobs, sweepPrintJobs, MAX_RETRIES } from "../src/lib/job-maintenance";
import { createPrintJobForPrinter } from "../src/lib/print-job-service";
import { GET as agentJobsGET } from "../src/app/api/agent/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("server-side print job maintenance", () => {
  let f: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  async function insertJob(id: string, status: string, retries = 0, ageSeconds = 120, expiresOffsetSeconds = 3600) {
    await pool().query(
      `INSERT INTO print_jobs (id, tenant_id, destination, document_type, agent_id, printer_id, status, payload, retries, claimed_at, delivered_at, acked_at, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'receipt', $4, $5, $6, '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, $7, now() - make_interval(secs => $8), NULL, NULL, now() + make_interval(secs => $9), now() - make_interval(secs => $8), now() - make_interval(secs => $8))`,
      [id, f.tenantId, f.destination, f.agentId, f.printerId, status, retries, ageSeconds, expiresOffsetSeconds],
    );
  }

  it("uses the database clock for the default one-hour TTL", async () => {
    const before = await pool().query("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
    const res = await createPrintJobForPrinter(f.printerId, {
      type: "raw",
      protocol: "raw",
      encoding: "base64",
      data: "aGVsbG8=",
    }, {
      tenantId: f.tenantId,
      requestedBy: "ttl-test",
      idempotencyKey: "db-clock-default-ttl",
    });
    expect(res.status).toBe("queued");

    const row = await pool().query(
      "SELECT EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_ms FROM print_jobs WHERE id = $1",
      [res.id],
    );
    const dbNow = Number(before.rows[0].now_ms);
    const expires = Number(row.rows[0].expires_ms);
    expect(expires - dbNow).toBeGreaterThan(59 * 60 * 1000);
    expect(expires - dbNow).toBeLessThan(61 * 60 * 1000);
  });

  it("expires overdue non-terminal jobs", async () => {
    await insertJob("job-expired-maintenance", "queued", 0, 120, -60);
    const result = await sweepPrintJobs();
    expect(result.expired).toBe(1);
    const row = await pool().query(`SELECT status, error FROM print_jobs WHERE id = $1`, ["job-expired-maintenance"]);
    expect(row.rows[0].status).toBe("expired");
    expect(row.rows[0].error).toBeNull();
  });

  it("requeues stale claims and the Agent can claim the recovered job", async () => {
    await insertJob("job-stale-claim", "claimed", 2, 120, 3600);
    const result = await sweepPrintJobs({ agentId: f.agentId });
    expect(result.requeuedClaims).toBe(1);

    const row = await pool().query(`SELECT status, retries, claimed_at, delivered_at, acked_at FROM print_jobs WHERE id = $1`, ["job-stale-claim"]);
    expect(row.rows[0]).toMatchObject({ status: "queued", retries: 3, claimed_at: null, delivered_at: null, acked_at: null });

    const response = await agentJobsGET(new Request("http://gateway.test/api/agent/jobs", {
      method: "GET",
      headers: { Authorization: f.agentAuth },
    }));
    expect(response.status).toBe(200);
    const claimed = await response.json();
    expect(claimed.some((job: { id: string; status: string }) => job.id === "job-stale-claim" && job.status === "claimed")).toBe(true);
  });

  it("fails a stale claim after the retry budget is exhausted", async () => {
    await insertJob("job-exhausted-claim", "claimed", MAX_RETRIES, 120, 3600);
    const result = await sweepPrintJobs();
    expect(result.exhaustedClaims).toBe(1);
    const row = await pool().query(`SELECT status, error FROM print_jobs WHERE id = $1`, ["job-exhausted-claim"]);
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].error).toContain("max retries");
  });

  it("marks a stale printing lease failed with UNKNOWN physical outcome and never requeues it", async () => {
    await insertJob("job-stale-printing", "printing", 0, 11 * 60, 3600);
    const result = await sweepPrintJobs();
    expect(result.stalePrinting).toBe(1);
    const row = await pool().query(`SELECT status, retries, error FROM print_jobs WHERE id = $1`, ["job-stale-printing"]);
    expect(row.rows[0].status).toBe("failed");
    expect(Number(row.rows[0].retries)).toBe(0);
    expect(row.rows[0].error).toContain("AGENT_EXECUTION_TIMEOUT");
    expect(row.rows[0].error).toContain("physical output is unknown");
  });

  it("marks a printing job that expires during execution as UNKNOWN", async () => {
    await insertJob("job-expired-printing", "printing", 0, 120, -60);
    const result = await sweepPrintJobs();
    expect(result.expired).toBe(1);
    const row = await pool().query(`SELECT status, error FROM print_jobs WHERE id = $1`, ["job-expired-printing"]);
    expect(row.rows[0].status).toBe("expired");
    expect(row.rows[0].error).toContain("JOB_EXPIRED_DURING_PRINT");
  });

  it("archives and removes terminal payload history after 48 hours without deleting active/recent jobs", async () => {
    await insertJob("retention-old-success", "success", 0, 49 * 60 * 60, 3600);
    await insertJob("retention-old-unknown", "failed", 0, 49 * 60 * 60, 3600);
    await pool().query(
      "UPDATE print_jobs SET error = 'UNKNOWN_PARTIAL_DELIVERY: historical evidence' WHERE id = $1",
      ["retention-old-unknown"],
    );
    await insertJob("retention-recent-success", "success", 0, 47 * 60 * 60, 3600);
    await insertJob("retention-active", "queued", 0, 49 * 60 * 60, 3600);

    expect(await cleanupTerminalPrintJobs()).toBe(2);

    const remaining = await pool().query("SELECT id FROM print_jobs ORDER BY id");
    const ids = remaining.rows.map((row) => row.id);
    expect(ids).toContain("retention-recent-success");
    expect(ids).toContain("retention-active");
    expect(ids).not.toContain("retention-old-success");
    expect(ids).not.toContain("retention-old-unknown");

    const receipts = await pool().query(
      "SELECT id FROM print_job_receipts WHERE id IN ($1, $2) ORDER BY id",
      ["retention-old-success", "retention-old-unknown"],
    );
    expect(receipts.rows.map((row) => row.id)).toEqual([
      "retention-old-success",
      "retention-old-unknown",
    ]);
  });

  it("archives large terminal backlogs in bounded inner batches without losing evidence", async () => {
    // C065: 45 terminal jobs exceed the 20-row materialization bound, so the
    // cleanup must loop inner batches. Every job still lands in receipts
    // with a verifiable fingerprint and leaves print_jobs.
    const total = 45;
    for (let i = 0; i < total; i++) {
      await insertJob(`retention-batch-${i}`, i % 2 === 0 ? "success" : "failed", 0, 49 * 60 * 60, 3600);
    }
    expect(await cleanupTerminalPrintJobs()).toBe(total);

    const remaining = await pool().query("SELECT COUNT(*)::int AS n FROM print_jobs WHERE id LIKE 'retention-batch-%'");
    expect(Number(remaining.rows[0]?.n)).toBe(0);
    const receipts = await pool().query("SELECT COUNT(*)::int AS n FROM print_job_receipts WHERE id LIKE 'retention-batch-%'");
    expect(Number(receipts.rows[0]?.n)).toBe(total);
    const sample = await pool().query(
      "SELECT fingerprint, printer_id, document_type, destination, payload FROM print_job_receipts WHERE id = $1",
      ["retention-batch-0"],
    );
    const { idempotencyDigest } = await import("../src/lib/print-job-service");
    expect(sample.rows[0]?.fingerprint).toBe(idempotencyDigest({
      printerId: sample.rows[0]?.printer_id,
      documentType: sample.rows[0]?.document_type,
      destination: sample.rows[0]?.destination,
      payload: sample.rows[0]?.payload,
    }));
  });

  it("fails a stale printing lease after retry history without creating another print attempt", async () => {
    await insertJob("job-stale-printing-history", "printing", MAX_RETRIES, 11 * 60, 3600);
    const result = await sweepPrintJobs();
    expect(result.stalePrinting).toBe(1);
    const row = await pool().query(`SELECT status, retries, error FROM print_jobs WHERE id = $1`, ["job-stale-printing-history"]);
    expect(row.rows[0].status).toBe("failed");
    expect(Number(row.rows[0].retries)).toBe(MAX_RETRIES);
    expect(row.rows[0].error).toContain("AGENT_EXECUTION_TIMEOUT");
  });
});