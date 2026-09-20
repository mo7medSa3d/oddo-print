import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  insertQueuedJob,
  jobRow,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { claimJobForDelivery } from "../src/lib/job-delivery";
import { POST as heartbeatPOST } from "../src/app/api/agent/heartbeat/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("heartbeat validation and lifecycle preservation", () => {
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

  it("does not resurrect a deleted Gateway-owned printer during the heartbeat race", async () => {
    await pool().query(`DELETE FROM printers WHERE id = $1 AND tenant_id = $2`, [f.printerId, f.tenantId]);

    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        gatewayOwnedPrinterIds: [f.printerId],
        printers: [{
          id: f.printerId,
          name: "Stale Gateway printer",
          printerType: "physical",
          deviceClass: "thermal",
          connectionType: "network",
          protocol: "raw",
          config: { ip: "10.0.0.20", port: 9100 },
          status: "online",
        }],
      }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skippedPrinters).toContainEqual({
      id: f.printerId,
      reason: "gateway_owned_deletion_pending",
    });

    const row = await pool().query(`SELECT id FROM printers WHERE id = $1 AND tenant_id = $2`, [f.printerId, f.tenantId]);
    expect(row.rows).toHaveLength(0);
  });

  it("leaves operator-disabled printers disabled", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);

    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "Should not resurrect",
          connectionType: "spooler",
          protocol: "spooler",
          status: "online",
        }],
      }),
    }));
    expect(res.status).toBe(200);

    const row = await pool().query(`SELECT lifecycle, status FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].lifecycle).toBe("disabled");
    expect(row.rows[0].status).toBe("online");
  });

  it("preserves manager-owned printer identity and configuration while returning desired state", async () => {
    await pool().query(
      `UPDATE printers SET management_source = 'manager', desired_revision = 7, applied_desired_revision = 4, observed_desired_revision = 4, name = $1, connection_type = $2, protocol = $3, config = $4::jsonb WHERE id = $5`,
      ["Manager Name", "network", "raw", JSON.stringify({ ip: "10.10.10.20", port: 9100 }), f.printerId],
    );

    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "Agent Name Must Not Win",
          connectionType: "spooler",
          protocol: "spooler",
          config: { spooler_name: "AgentQueue" },
          status: "online",
          capabilities: { supported_protocols: ["raw", "escpos"] },
        }],
      }),
    }));
    expect(res.status).toBe(200);

    const row = await pool().query(`SELECT name, connection_type, protocol, config, status, management_source FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].name).toBe("Manager Name");
    expect(row.rows[0].connection_type).toBe("network");
    expect(row.rows[0].protocol).toBe("raw");
    expect(row.rows[0].config).toEqual({ ip: "10.10.10.20", port: 9100 });
    expect(row.rows[0].status).toBe("online");
    expect(row.rows[0].management_source).toBe("manager");

    const body = await res.json();
    expect(body.desiredState).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: f.printerId,
        name: "Manager Name",
        connectionType: "network",
        protocol: "raw",
        config: { ip: "10.10.10.20", port: 9100 },
      }),
    ]));
  });

  it("accepts monotonic desired-state acknowledgements and fences them to the authenticated tenant and agent", async () => {
    await pool().query(
      `UPDATE printers
       SET management_source = 'manager',
           desired_revision = 9,
           applied_desired_revision = 2,
           observed_desired_revision = 2
       WHERE id = $1`,
      [f.printerId],
    );

    const beat = (ack: unknown) => heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ status: "online", printers: [], desiredStateAcks: [ack] }),
    }));

    expect((await beat({
      printerId: f.printerId,
      appliedDesiredRevision: 8,
      observedDesiredRevision: 8,
    })).status).toBe(200);

    let row = await pool().query(
      `SELECT desired_revision, applied_desired_revision, observed_desired_revision
       FROM printers WHERE id = $1`,
      [f.printerId],
    );
    expect(row.rows[0]).toEqual({
      desired_revision: "9",
      applied_desired_revision: "8",
      observed_desired_revision: "8",
    });

    expect((await beat({
      printerId: f.printerId,
      appliedDesiredRevision: 7,
      observedDesiredRevision: 7,
    })).status).toBe(200);

    row = await pool().query(
      `SELECT desired_revision, applied_desired_revision, observed_desired_revision
       FROM printers WHERE id = $1`,
      [f.printerId],
    );
    expect(row.rows[0]).toEqual({
      desired_revision: "9",
      applied_desired_revision: "8",
      observed_desired_revision: "8",
    });

    const other = await seedFixture();
    expect((await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: other.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [],
        desiredStateAcks: [{
          printerId: f.printerId,
          appliedDesiredRevision: 9,
          observedDesiredRevision: 9,
        }],
      }),
    }))).status).toBe(200);

    row = await pool().query(
      `SELECT applied_desired_revision, observed_desired_revision
       FROM printers WHERE id = $1`,
      [f.printerId],
    );
    expect(row.rows[0]).toEqual({
      applied_desired_revision: "8",
      observed_desired_revision: "8",
    });
  });

  it("refuses to update a printer owned by another agent", async () => {
    const other = await seedFixture();
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: other.printerId,
          name: "Hijack",
          connectionType: "spooler",
          protocol: "spooler",
          status: "online",
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skippedPrinters).toContainEqual(expect.objectContaining({ id: other.printerId }));
    const row = await pool().query(`SELECT agent_id, name FROM printers WHERE id = $1`, [other.printerId]);
    expect(row.rows[0].agent_id).toBe(other.agentId);
    expect(row.rows[0].name).not.toBe("Hijack");
  });

  it("fences the whole heartbeat when agent lifecycle changes concurrently", async () => {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM agents WHERE id = $1 FOR UPDATE`, [f.agentId]);

      const heartbeat = heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
        method: "POST",
        headers: { Authorization: f.agentAuth, "content-type": "application/json" },
        body: JSON.stringify({
          status: "online",
          printers: [],
          desiredStateAcks: [{
            printerId: f.printerId,
            appliedDesiredRevision: 99,
            observedDesiredRevision: 99,
          }],
        }),
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.query(`UPDATE agents SET lifecycle = 'disabled', status = 'offline' WHERE id = $1`, [f.agentId]);
      await client.query("COMMIT");

      const res = await heartbeat;
      expect(res.status).toBe(409);

      const agent = await pool().query(`SELECT lifecycle, status FROM agents WHERE id = $1`, [f.agentId]);
      expect(agent.rows[0]).toEqual({ lifecycle: "disabled", status: "offline" });

      const printer = await pool().query(
        `SELECT applied_desired_revision, observed_desired_revision FROM printers WHERE id = $1`,
        [f.printerId],
      );
      expect(printer.rows[0]).toMatchObject({
        applied_desired_revision: "0",
        observed_desired_revision: "0",
      });
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
  });

  it("rejects an invalid agent status without mutating the existing agent", async () => {
    const before = await pool().query(`SELECT status, last_seen_at FROM agents WHERE id = $1`, [f.agentId]);

    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ status: "definitely-not-valid", printers: [] }),
    }));
    expect(res.status).toBe(400);

    const after = await pool().query(`SELECT status, last_seen_at FROM agents WHERE id = $1`, [f.agentId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("normalizes agent and printer status casing/whitespace", async () => {
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: " ONLINE ",
        printers: [{
          id: f.printerId,
          name: "Normalized",
          printerType: "physical",
          deviceClass: "other",
          connectionType: "spooler",
          protocol: "spooler",
          config: { spooler_name: "NormalizedQueue" },
          status: " OFFLINE ",
        }],
      }),
    }));
    expect(res.status).toBe(200);

    const row = await pool().query(`SELECT status FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].status).toBe("offline");

    const agent = await pool().query(`SELECT status FROM agents WHERE id = $1`, [f.agentId]);
    expect(agent.rows[0].status).toBe("online");
  });

  it("bounds reported capabilities to the known vocabulary without failing the heartbeat", async () => {
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "CapsBounded",
          printerType: "physical",
          deviceClass: "thermal",
          connectionType: "network",
          protocol: "raw",
          config: { ip: "192.168.44.10", port: 9100 },
          status: "online",
          capabilities: { supported_protocols: ["raw", "LASER-9000", 42, "zpl"] },
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const row = await pool().query(`SELECT capabilities FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].capabilities.supported_protocols).toEqual(["raw", "zpl"]);
  });

  it("rejects a non-array supported_protocols instead of restoring transport fallback", async () => {
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "CapsMalformed",
          printerType: "physical",
          deviceClass: "thermal",
          connectionType: "network",
          protocol: "escpos",
          config: { ip: "192.168.44.11", port: 9100 },
          status: "online",
          capabilities: { supported_protocols: "raw" },
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skippedPrinters).toContainEqual({ id: f.printerId, reason: "invalid_supported_protocols" });
    const row = await pool().query(`SELECT capabilities, name FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].name).not.toBe("CapsMalformed");
  });

  it("fences keep-alive lease refresh to the live claim (stale worker TOCTOU)", async () => {
    await insertQueuedJob(f, "job_hb_fence");
    const claim = await claimJobForDelivery("job_hb_fence", f.agentId);
    const liveToken = claim!.claimToken!;
    expect(typeof liveToken).toBe("string");
    await pool().query(`UPDATE print_jobs SET updated_at = now() - interval '200 seconds' WHERE id = 'job_hb_fence'`);
    const staleAt = (await jobRow("job_hb_fence")).updated_at as Date;

    const beat = (auth: string, keepAliveJobIds: unknown) => heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ status: "online", printers: [], keepAliveJobIds }),
    }));

    expect((await beat(f.agentAuth, [{ jobId: "job_hb_fence", claimToken: "forged-token" }])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBe(new Date(staleAt).getTime());
    expect((await beat(f.agentAuth, ["job_hb_fence"])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBe(new Date(staleAt).getTime());
    const other = await seedFixture();
    expect((await beat(other.agentAuth, [{ jobId: "job_hb_fence", claimToken: liveToken }])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBe(new Date(staleAt).getTime());
    expect((await beat(f.agentAuth, [{ jobId: "job_hb_fence", claimToken: liveToken }])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
  });
});