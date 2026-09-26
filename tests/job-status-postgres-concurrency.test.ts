import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, insertQueuedJob, jobRow, pool, closePool, type Fixture } from "./helpers/pg";
import { PATCH as jobStatusPATCH } from "../src/app/api/agent/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("atomic Agent job status transitions", () => {
  let f: Fixture;
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); });

  it("keeps spooler linkage inside the claim-fenced status transition", async () => {
    await insertQueuedJob(f, "job_spooler_fence");
    await pool().query(
      `UPDATE print_jobs
       SET status='printing', claim_token='tok-spooler-a', updated_at=now()
       WHERE id='job_spooler_fence'`,
    );

    const patch = (claimToken?: string) => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "job_spooler_fence",
        status: "success",
        spoolerJobId: "spooler-123",
        ...(claimToken ? { claimToken } : {}),
      }),
    }));

    // A stale attempt must not be able to attach its spooler evidence to the
    // current claim, even though it knows the logical job id.
    expect((await patch("tok-spooler-b")).status).toBe(409);
    const afterStale = await pool().query(
      `SELECT status, claim_token, spooler_job_id
       FROM print_jobs
       WHERE id='job_spooler_fence'`,
    );
    expect(afterStale.rows[0]).toMatchObject({
      status: "printing",
      claim_token: "tok-spooler-a",
      spooler_job_id: null,
    });

    // The live claim can attach spooler evidence as part of the same terminal
    // transition, so there is no second un-fenced write window.
    expect((await patch("tok-spooler-a")).status).toBe(200);
    const afterLive = await pool().query(
      `SELECT status, claim_token, spooler_job_id
       FROM print_jobs
       WHERE id='job_spooler_fence'`,
    );
    expect(afterLive.rows[0]).toMatchObject({
      status: "success",
      claim_token: null,
      spooler_job_id: "spooler-123",
    });
  });

  it("allows at most one of two concurrent printing->terminal transitions", async () => {
    await insertQueuedJob(f, "job_race");
    await pool().query(`UPDATE print_jobs SET status='printing' WHERE id='job_race'`);
    const p1 = pool().connect(); const p2 = pool().connect();
    const [a,b] = await Promise.all([p1,p2]);
    try {
      const expected = "printing";
      const [ra,rb] = await Promise.all([
        a.query(`UPDATE print_jobs SET status='success', updated_at=now() WHERE id=$1 AND agent_id=$2 AND status=$3 RETURNING status`, ["job_race", f.agentId, expected]),
        b.query(`UPDATE print_jobs SET status='failed', updated_at=now() WHERE id=$1 AND agent_id=$2 AND status=$3 RETURNING status`, ["job_race", f.agentId, expected]),
      ]);
      expect((ra.rowCount ?? 0) + (rb.rowCount ?? 0)).toBe(1);
      const row = await pool().query(`SELECT status FROM print_jobs WHERE id='job_race'`);
      expect(["success", "failed"]).toContain(row.rows[0].status);
    } finally { a.release(); b.release(); }
  });

  it("rejects a concurrent transition from a terminal winner", async () => {
    await insertQueuedJob(f, "job_terminal");
    await pool().query(`UPDATE print_jobs SET status='success' WHERE id='job_terminal'`);
    const res = await pool().query(`UPDATE print_jobs SET status='failed' WHERE id=$1 AND agent_id=$2 AND status='printing' RETURNING status`, ["job_terminal", f.agentId]);
    expect(res.rowCount).toBe(0);
  });
  it("rejects one conflicting transition when two HTTP PATCH requests race", async () => {
    await insertQueuedJob(f, "job_api_race");
    await pool().query(`UPDATE print_jobs SET status='printing' WHERE id='job_api_race'`);
    const request = (status: "success" | "failed") => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job_api_race", status }),
    }));
    const [a, b] = await Promise.all([request("success"), request("failed")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await pool().query(`SELECT status FROM print_jobs WHERE id='job_api_race'`);
    expect(["success", "failed"]).toContain(row.rows[0].status);
  });

  it("rejects lifecycle mutations from queued jobs without the exact live claim token", async () => {
    await insertQueuedJob(f, "job_unclaimed_status");
    const patch = (status: string, claimToken?: string) => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job_unclaimed_status", status, ...(claimToken ? { claimToken } : {}) }),
    }));

    expect((await patch("printing")).status).toBe(409);
    expect((await patch("success")).status).toBe(409);
    expect((await patch("failed")).status).toBe(409);
    expect((await jobRow("job_unclaimed_status")).status).toBe("queued");

    await pool().query(`UPDATE print_jobs SET status='claimed', claim_token='tok-live', delivered_at=now(), claimed_at=now() WHERE id='job_unclaimed_status'`);
    expect((await patch("printing", "wrong-token")).status).toBe(409);
    expect((await patch("printing", "tok-live")).status).toBe(200);
  });

  it("refuses claimed -> queued requeue after delivery evidence exists", async () => {
    await insertQueuedJob(f, "job_post_delivery_requeue");
    await pool().query(`UPDATE print_jobs SET status='claimed', claim_token='tok-delivered', delivered_at=now(), claimed_at=now() WHERE id='job_post_delivery_requeue'`);
    const patch = await jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job_post_delivery_requeue", status: "queued", reason: "pending_full", claimToken: "tok-delivered" }),
    }));
    expect(patch.status).toBe(409);
    expect((await jobRow("job_post_delivery_requeue")).status).toBe("claimed");
  });

  it("expired late success requires the preserved delivered claim fence", async () => {
    await insertQueuedJob(f, "job_expired_reconcile");
    await pool().query(`UPDATE print_jobs SET status='expired', expires_at=now() - interval '1 second', claimed_at=now(), delivered_at=now(), claim_token='tok-expired', error='JOB_EXPIRED_DURING_PRINT: physical output is unknown' WHERE id='job_expired_reconcile'`);
    const patch = (claimToken?: string) => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job_expired_reconcile", status: "success", ...(claimToken ? { claimToken } : {}) }),
    }));
    expect((await patch()).status).toBe(409);
    expect((await patch("wrong-token")).status).toBe(409);
    expect((await patch("tok-expired")).status).toBe(200);
  });

  it("late success through the route requires the unknown-wait marker AND a fresh failure", async () => {
    const patch = (jobId: string, status: string, claimToken?: string) => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId, status, ...(claimToken ? { claimToken } : {}) }),
    }));
    // 1. Plain failures can never become successes.
    await insertQueuedJob(f, "job_late_plain");
    await pool().query(`UPDATE print_jobs SET status='failed', error='CONNECTION_ERROR: refused', updated_at=now() WHERE id='job_late_plain'`);
    expect((await patch("job_late_plain", "success")).status).toBe(409);
    // 2. A gateway-timeout failure WITHIN 24h may be reconciled when the agent
    // reports execution completion. Current transports still cannot prove paper output.
    await insertQueuedJob(f, "job_late_ok");
    await pool().query(`UPDATE print_jobs SET status='failed', error='AGENT_EXECUTION_TIMEOUT: agent execution lease expired (physical output is unknown; manual reconciliation required)', updated_at=now() WHERE id='job_late_ok'`);
    const ok = await patch("job_late_ok", "success");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { physicalOutcome?: string }).physicalOutcome).toBe("unknown");
    // 3. The same marker past the 24h TTL is no longer overridable.
    await insertQueuedJob(f, "job_late_stale");
    await pool().query(`UPDATE print_jobs SET status='failed', error='AGENT_RESTART_DURING_PRINT: crashed', updated_at=now() - interval '25 hours' WHERE id='job_late_stale'`);
    expect((await patch("job_late_stale", "success")).status).toBe(409);
    // 4. An expired job that was never claimed must not be promotable to
    // success just because an authenticated Agent knows its id.
    await insertQueuedJob(f, "job_expired_unclaimed");
    await pool().query(`UPDATE print_jobs SET status='expired', expires_at=now() - interval '1 second', updated_at=now() WHERE id='job_expired_unclaimed'`);
    expect((await patch("job_expired_unclaimed", "success")).status).toBe(409);
    expect((await jobRow("job_expired_unclaimed")).status).toBe("expired");

    // 5. Late success is bound to the EXACT attempt that produced the
    // marker: the row below failed while token-A held the claim. A report
    // carrying any other token (or none) is rejected even though the
    // marker and TTL would otherwise qualify.
    await insertQueuedJob(f, "job_late_attempt");
    await pool().query(`UPDATE print_jobs SET status='failed', claim_token='tok-attempt-a', error='AGENT_EXECUTION_TIMEOUT: agent execution lease expired', updated_at=now() WHERE id='job_late_attempt'`);
    expect((await patch("job_late_attempt", "success", "tok-attempt-b")).status).toBe(409);
    expect((await patch("job_late_attempt", "success")).status).toBe(409);
    expect((await jobRow("job_late_attempt")).status).toBe("failed");
    const lateOwn = await patch("job_late_attempt", "success", "tok-attempt-a");
    expect(lateOwn.status).toBe(200);
    expect(((await lateOwn.json()) as { physicalOutcome?: string }).physicalOutcome).toBe("unknown");
  });

});
