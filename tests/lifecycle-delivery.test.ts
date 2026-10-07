import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { claimJobForDelivery } from "../src/lib/job-delivery";
import { PATCH as agentJobsPATCH } from "../src/app/api/agent/jobs/route";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  insertQueuedJob,
  jobRow,
  pool,
  closePool,
  type Fixture,
} from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

type Lifecycle = "active" | "disabled" | "retired";

suite("delivery lifecycle enforcement", () => {
  let f: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  async function setLifecycle(kind: "agent" | "printer", lifecycle: Lifecycle) {
    const table = kind === "agent" ? "agents" : "printers";
    const id = kind === "agent" ? f.agentId : f.printerId;
    await pool().query(`UPDATE ${table} SET lifecycle = $1 WHERE id = $2`, [lifecycle, id]);
  }

  it.each(["disabled", "retired"] as Lifecycle[])('does not claim a queued job for a %s printer', async (lifecycle) => {
    await insertQueuedJob(f, `printer_${lifecycle}`);
    await setLifecycle("printer", lifecycle);

    expect(await claimJobForDelivery(`printer_${lifecycle}`, f.agentId)).toBeNull();
    expect((await jobRow(`printer_${lifecycle}`)).status).toBe("queued");
  });

  it.each(["disabled", "retired"] as Lifecycle[])('does not claim a queued job for a %s agent', async (lifecycle) => {
    await insertQueuedJob(f, `agent_${lifecycle}`);
    await setLifecycle("agent", lifecycle);

    expect(await claimJobForDelivery(`agent_${lifecycle}`, f.agentId)).toBeNull();
    expect((await jobRow(`agent_${lifecycle}`)).status).toBe("queued");
  });

  it("refuses printing admission for an agent disabled after authentication", async () => {
    // C023: authentication already passed when the disable lands, so only
    // the statement-bound lifecycle fence can refuse admission. Hold the job
    // row lock so the PATCH handler blocks inside its UPDATE; commit the
    // disable while it waits. Either interleaving must yield 409 with the
    // claim intact (the disable is committed before the UPDATE executes, or
    // the UPDATE waits for it).
    await insertQueuedJob(f, "job_admission_race");
    const claim = await claimJobForDelivery("job_admission_race", f.agentId);
    expect(claim?.claimToken).toBeTruthy();

    const holder = await pool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM print_jobs WHERE id = $1 FOR UPDATE`, ["job_admission_race"]);

      const patching = agentJobsPATCH(
        new Request("http://gateway.test/api/agent/jobs", {
          method: "PATCH",
          headers: { Authorization: f.agentAuth, "content-type": "application/json" },
          body: JSON.stringify({ jobId: "job_admission_race", status: "printing", claimToken: claim!.claimToken }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await pool().query(`UPDATE agents SET lifecycle = 'disabled' WHERE id = $1`, [f.agentId]);
      await holder.query("COMMIT");

      const res = await patching;
      expect(res.status).toBe(409);
      expect((await jobRow("job_admission_race")).status).toBe("claimed");
    } finally {
      try { await holder.query("ROLLBACK"); } catch {}
      holder.release();
    }
  });

  it("refuses printing admission for a tenant suspended after claim", async () => {
    // Same C023 choreography for the tenant leg: suspend lands after
    // authentication, so only the statement-bound fence can refuse.
    await insertQueuedJob(f, "job_tenant_race");
    const claim = await claimJobForDelivery("job_tenant_race", f.agentId);
    expect(claim?.claimToken).toBeTruthy();

    const holder = await pool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM print_jobs WHERE id = $1 FOR UPDATE`, ["job_tenant_race"]);

      const patching = agentJobsPATCH(
        new Request("http://gateway.test/api/agent/jobs", {
          method: "PATCH",
          headers: { Authorization: f.agentAuth, "content-type": "application/json" },
          body: JSON.stringify({ jobId: "job_tenant_race", status: "printing", claimToken: claim!.claimToken }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await pool().query(`UPDATE tenants SET lifecycle = 'suspended' WHERE id = $1`, [f.tenantId]);
      await holder.query("COMMIT");

      const res = await patching;
      expect(res.status).toBe(409);
      expect((await jobRow("job_tenant_race")).status).toBe("claimed");
    } finally {
      try { await holder.query("ROLLBACK"); } catch {}
      holder.release();
    }

    // The fence must stay wired to the printing branch only: terminal
    // reconciliation never consults liveness.
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/agent/jobs/route.ts", "utf8");
    expect(route).toContain("printingAdmissionLifecycleFence(agent.id, agent.tenantId)");
  });

  it("linearizes a printer lifecycle update and a claim on the same owner row", async () => {
    await insertQueuedJob(f, "race_lifecycle");
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM printers WHERE id = $1 FOR UPDATE`, [f.printerId]);

      const claiming = claimJobForDelivery("race_lifecycle", f.agentId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
      await client.query("COMMIT");

      expect(await claiming).toBeNull();
      expect((await jobRow("race_lifecycle")).status).toBe("queued");
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
  });
});
