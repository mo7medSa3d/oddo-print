import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "../src/db";
import { printJobs } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { hasTestDatabase, applyMigrations, truncateAll, closePool, seedFixture, insertQueuedJob, jobRow } from "./helpers/pg";
import { claimJobForDelivery, releaseUndeliveredClaim } from "../src/lib/job-delivery";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("releaseUndeliveredClaim guards (A-7)", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); });

  it("requeues a live claim and accounts the retry budget", async () => {
    const f = await seedFixture();
    const id = `job_a7_${nanoid(6)}`;
    await insertQueuedJob(f, id);
    const claim = await claimJobForDelivery(id, f.agentId, { markDeliveryEvidencePending: true });
    expect(claim?.claimToken).toBeTruthy();
    const out = await releaseUndeliveredClaim(id, f.tenantId, f.agentId, claim!.claimToken, "test release");
    expect(out).toBe("requeued");
    const row = await jobRow(id);
    expect(row.status).toBe("queued");
    // Budgets untouched by a safe return: the claim consumed one delivery
    // attempt at claim time; retries stay 0 (pinned by ws-claim-delivery).
    expect(Number(row.delivery_attempts)).toBe(1);
    expect(Number(row.retries)).toBe(0);
    expect(row.claim_token).toBeNull();
  });

  it("does not requeue an expired claim (leaves it for the sweeper)", async () => {
    const f = await seedFixture();
    const id = `job_a7_${nanoid(6)}`;
    await insertQueuedJob(f, id);
    const claim = await claimJobForDelivery(id, f.agentId, { markDeliveryEvidencePending: true });
    expect(claim?.claimToken).toBeTruthy();
    await db.update(printJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(printJobs.id, id));
    const out = await releaseUndeliveredClaim(id, f.tenantId, f.agentId, claim!.claimToken, "test release");
    expect(out).toBe("noop");
    const row = await jobRow(id);
    expect(row.status).toBe("claimed");
  });
});
