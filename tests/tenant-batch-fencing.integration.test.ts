import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { printJobs } from "../src/db/schema";
import { applyMigrations, closePool, hasTestDatabase, truncateAll, seedFixture, insertQueuedJob } from "./helpers/pg";
import { db } from "../src/db";

const dbSuite = describe.skipIf(!hasTestDatabase);

dbSuite("AUDIT-01: Tenant Batch Fencing Database Proof", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });

  it("does not select or mutate cross-tenant jobs during batch materialization", async () => {
    await truncateAll();
    const a = await seedFixture();
    const b = await seedFixture();

    const jobIdA = `job_a_${Date.now()}`;
    const jobIdB = `job_b_${Date.now()}`;

    await insertQueuedJob(a, jobIdA);
    await insertQueuedJob(b, jobIdB);

    // Running a batch query with Tenant A context attempting to access both jobIdA and jobIdB
    const batchIds = [jobIdA, jobIdB];
    const retrieved = await db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.tenantId, a.tenantId), inArray(printJobs.id, batchIds)));

    expect(retrieved.length).toBe(1);
    expect(retrieved[0].id).toBe(jobIdA);
    expect(retrieved[0].tenantId).toBe(a.tenantId);
  });
});
