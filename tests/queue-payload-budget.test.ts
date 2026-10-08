import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentQueuedJobsFullError, createPrintJobForPrinter } from "../src/lib/print-job-service";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

describe.skipIf(!hasTestDatabase)("queue logical payload ceiling", () => {
  beforeAll(applyMigrations);
  afterAll(closePool);
  beforeEach(truncateAll);
  it("rejects 20th compressible 5MiB job when queued logical bytes exceed 128MiB", async () => {
    const f = await seedFixture();
    const chars = Math.ceil(5 * 1024 * 1024 / 3) * 4;
    await pool().query(`
      INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at)
      SELECT 'queue_budget_' || n::text, $1, $2, $3, 'queued',
             jsonb_build_object('type','raw','protocol','raw','encoding','base64','data',repeat('A',$4::int)),
             now() + interval '1 hour'
      FROM generate_series(1,19) n
    `, [f.tenantId, f.agentId, f.printerId, chars]);
    const sizes = (await pool().query(
      "SELECT SUM(octet_length(payload::text)) AS logical, SUM(pg_column_size(payload)) AS storage FROM print_jobs WHERE agent_id=$1",
      [f.agentId],
    )).rows[0];
    expect(Number(sizes.logical)).toBeGreaterThan(120 * 1024 * 1024);
    expect(Number(sizes.storage)).toBeLessThan(Number(sizes.logical));
    await expect(createPrintJobForPrinter(f.printerId, {
      type: "raw", protocol: "raw", encoding: "base64", data: "A".repeat(chars),
    }, { tenantId: f.tenantId, requestedBy: "queue-budget-test", destination: f.destination, documentType: "receipt" }))
      .rejects.toBeInstanceOf(AgentQueuedJobsFullError);
    const count = (await pool().query("SELECT COUNT(*)::int AS n FROM print_jobs WHERE agent_id=$1", [f.agentId])).rows[0];
    expect(count.n).toBe(19);
  }, 120000);
});
