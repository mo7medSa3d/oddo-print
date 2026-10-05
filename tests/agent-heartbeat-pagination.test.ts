import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { POST as heartbeatPOST } from "../src/app/api/agent/heartbeat/route";
import { GET as odooPrintersGET } from "../src/app/api/odoo/printers/route";
import { GET as agentJobsGET } from "../src/app/api/agent/jobs/route";
import { POST as printJobsPOST } from "../src/app/api/print/jobs/route";
import { claimJobForDelivery } from "../src/lib/job-delivery";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool, insertQueuedJob, jobRow } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function makePrinter(id: string) {
  return {
    id,
    name: id,
    printerType: "physical",
    deviceClass: "other",
    connectionType: "network",
    protocol: "raw",
    status: "online",
    config: { ip: "10.0.0.10", port: 9100 },
    capabilities: { supported_protocols: ["raw"] },
  };
}

async function heartbeat(agentAuth: string, body: unknown) {
  return heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
    method: "POST",
    headers: {
      authorization: agentAuth,
      "content-type": "application/json",
      "x-real-ip": "127.0.0.40",
    },
    body: JSON.stringify(body),
  }));
}

function snapshotHeartbeat(snapshotId: string, inventoryComplete: boolean, printerRows: unknown[], heartbeatPage = 1, heartbeatPageCount = 1) {
  return {
    status: "online",
    heartbeatPage,
    heartbeatPageCount,
    inventorySnapshotId: snapshotId,
    inventoryComplete,
    printers: printerRows,
    desiredStateAcks: [],
    gatewayOwnedPrinterIds: [],
  };
}

function printJobRequest(odooKey: string, printerId: string) {
  return new Request("http://gateway.test/api/print/jobs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${odooKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      printerId,
      destination: "POS",
      documentType: "receipt",
      payload: {
        type: "raw",
        protocol: "raw",
        encoding: "base64",
        data: Buffer.from("inventory-fence").toString("base64"),
      },
    }),
  });
}

suite("agent heartbeat pagination contract", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it("accepts 501 printers across multiple pages without truncating inventory", async () => {
    const f = await seedFixture();
    const pageOne = Array.from({ length: 500 }, (_, i) => makePrinter(`hb-${String(i).padStart(4, "0")}`));
    const pageTwo = [makePrinter("hb-0500")];

    const first = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 1,
      heartbeatPageCount: 2,
      printers: pageOne,
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.desiredState).toBeUndefined();

    const second = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 2,
      heartbeatPageCount: 2,
      printers: pageTwo,
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(Array.isArray(secondBody.desiredState)).toBe(true);

    const rows = await pool().query(
      `SELECT id
       FROM printers
       WHERE tenant_id = $1 AND id LIKE 'hb-%'
       ORDER BY id`,
      [f.tenantId],
    );
    expect(rows.rows.map((row) => row.id)).toHaveLength(501);
  });

  it("rejects invalid page metadata before touching the tenant inventory", async () => {
    const f = await seedFixture();
    const response = await heartbeat(f.agentAuth, {
      status: "online",
      heartbeatPage: 2,
      heartbeatPageCount: 1,
      printers: [makePrinter("hb-invalid-page")],
      desiredStateAcks: [],
      gatewayOwnedPrinterIds: [],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("heartbeatPage"),
    });

    const rows = await pool().query(
      `SELECT COUNT(*)::int AS count
       FROM printers
       WHERE tenant_id = $1 AND id = 'hb-invalid-page'`,
      [f.tenantId],
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("skips only over-limit new printers while refreshing the existing fleet", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE plans
       SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb)
       WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)`,
      [f.tenantId],
    );
    await pool().query(
      `UPDATE agents SET last_seen_at = now() - interval '10 minutes' WHERE id = $1 AND tenant_id = $2`,
      [f.agentId, f.tenantId],
    );
    await pool().query(
      `UPDATE printers SET last_seen_at = now() - interval '10 minutes' WHERE id = $1 AND tenant_id = $2`,
      [f.printerId, f.tenantId],
    );

    const response = await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-over-limit",
      true,
      [makePrinter(f.printerId), makePrinter("hb-over-limit")],
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      skippedPrinters: expect.arrayContaining([
        { id: "hb-over-limit", reason: "max_printers_exceeded" },
      ]),
    });

    const existing = await pool().query(
      `SELECT
         a.last_seen_at > now() - interval '1 minute' AS agent_fresh,
         p.last_seen_at > now() - interval '1 minute' AS printer_fresh,
         p.inventory_present
       FROM agents a
       JOIN printers p ON p.agent_id = a.id AND p.tenant_id = a.tenant_id
       WHERE a.id = $1 AND a.tenant_id = $2 AND p.id = $3`,
      [f.agentId, f.tenantId, f.printerId],
    );
    expect(existing.rows[0]).toMatchObject({ agent_fresh: true, printer_fresh: true, inventory_present: true });

    const rejected = await pool().query(
      `SELECT COUNT(*)::int AS count FROM printers WHERE tenant_id = $1 AND id = 'hb-over-limit'`,
      [f.tenantId],
    );
    expect(rejected.rows[0].count).toBe(0);
  });

  it("marks a missing agent-owned printer absent only after a complete snapshot and hides it from Odoo inventory", async () => {
    const f = await seedFixture();

    const response = await heartbeat(f.agentAuth, snapshotHeartbeat("snap-complete-empty", true, []));
    expect(response.status).toBe(200);

    const row = await pool().query(
      `SELECT inventory_present, inventory_snapshot_id, status
       FROM printers WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, f.printerId],
    );
    expect(row.rows[0]).toMatchObject({ inventory_present: false, status: "unknown" });

    const odooResponse = await odooPrintersGET(new Request("http://gateway.test/api/odoo/printers", {
      headers: { Authorization: `Bearer ${f.odooKey}` },
    }));
    expect(odooResponse.status).toBe(200);
    const odooBody = await odooResponse.json();
    expect(odooBody.printers.find((printer: { id: string }) => printer.id === f.printerId)).toBeUndefined();
  });

  it("does not delete healthy inventory from an explicitly incomplete snapshot", async () => {
    const f = await seedFixture();

    const response = await heartbeat(f.agentAuth, snapshotHeartbeat("snap-incomplete", false, []));
    expect(response.status).toBe(200);

    const row = await pool().query(
      `SELECT inventory_present FROM printers WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, f.printerId],
    );
    expect(row.rows[0].inventory_present).toBe(true);
  });

  it("does not reconcile absence when a complete snapshot page contains invalid printer evidence", async () => {
    const f = await seedFixture();

    const response = await heartbeat(f.agentAuth, snapshotHeartbeat("snap-invalid-row", true, [
      { id: f.printerId, name: "incomplete-row" },
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      skippedPrinters: expect.arrayContaining([
        expect.objectContaining({ id: f.printerId }),
      ]),
    });

    const row = await pool().query(
      `SELECT inventory_present FROM printers WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, f.printerId],
    );
    expect(row.rows[0].inventory_present).toBe(true);
  });

  it("rejects out-of-order or replaced snapshot pages without destructive reconciliation", async () => {
    const f = await seedFixture();

    const first = await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-ordered-a",
      true,
      [makePrinter(f.printerId)],
      1,
      2,
    ));
    expect(first.status).toBe(200);

    const second = await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-ordered-b",
      true,
      [],
      2,
      2,
    ));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "INVENTORY_SNAPSHOT_CONFLICT", expectedPage: 2 });

    const state = await pool().query(
      `SELECT a.inventory_snapshot_id, a.inventory_snapshot_next_page, p.inventory_present
       FROM agents a
       JOIN printers p ON p.agent_id = a.id AND p.tenant_id = a.tenant_id
       WHERE a.id = $1 AND a.tenant_id = $2 AND p.id = $3`,
      [f.agentId, f.tenantId, f.printerId],
    );
    expect(state.rows[0]).toMatchObject({
      inventory_snapshot_id: "snap-ordered-a",
      inventory_snapshot_next_page: 2,
      inventory_present: true,
    });
  });

  it("reactivates the same stable printer ID when it reappears in a later complete snapshot", async () => {
    const f = await seedFixture();

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-gone", true, []))).status).toBe(200);
    expect((await pool().query(
      `SELECT inventory_present FROM printers WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, f.printerId],
    )).rows[0].inventory_present).toBe(false);

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-back",
      true,
      [makePrinter(f.printerId)],
    ))).status).toBe(200);

    const row = await pool().query(
      `SELECT inventory_present, inventory_snapshot_id, last_seen_at > now() - interval '1 minute' AS fresh
       FROM printers WHERE tenant_id = $1 AND id = $2`,
      [f.tenantId, f.printerId],
    );
    expect(row.rows[0]).toMatchObject({ inventory_present: true, inventory_snapshot_id: "snap-back", fresh: true });
  });

  it("releases max_printers capacity after confirmed absence so a replacement can be admitted", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE plans
       SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb)
       WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)`,
      [f.tenantId],
    );

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-retire-old", true, []))).status).toBe(200);
    const replacement = await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-replacement",
      true,
      [makePrinter("hb-replacement")],
    ));
    expect(replacement.status).toBe(200);
    expect(await replacement.json()).toMatchObject({ skippedPrinters: [] });

    const rows = await pool().query(
      `SELECT id, inventory_present FROM printers WHERE tenant_id = $1 ORDER BY id`,
      [f.tenantId],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.printerId, inventory_present: false }),
      expect.objectContaining({ id: "hb-replacement", inventory_present: true }),
    ]));
  });

  it("does not let a tombstoned stable ID bypass max_printers when its replacement owns the slot", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE plans
       SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb)
       WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)`,
      [f.tenantId],
    );

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-old-absent", true, []))).status).toBe(200);
    expect((await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-replacement-active",
      true,
      [makePrinter("hb-replacement")],
    ))).status).toBe(200);

    const reappearance = await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-old-reappears-at-capacity",
      true,
      [makePrinter("hb-replacement"), makePrinter(f.printerId)],
    ));
    expect(reappearance.status).toBe(200);
    expect(await reappearance.json()).toMatchObject({
      skippedPrinters: expect.arrayContaining([
        { id: f.printerId, reason: "max_printers_exceeded" },
      ]),
    });

    const rows = await pool().query(
      `SELECT id, inventory_present, status
       FROM printers
       WHERE tenant_id = $1 AND id = ANY($2::text[])
       ORDER BY id`,
      [f.tenantId, [f.printerId, "hb-replacement"]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.printerId, inventory_present: false, status: "unknown" }),
      expect.objectContaining({ id: "hb-replacement", inventory_present: true }),
    ]));
    expect(rows.rows.filter((row) => row.inventory_present)).toHaveLength(1);
  });

  it("allows a tombstoned stable ID to reappear after its replacement slot is actually freed", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE plans
       SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb)
       WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)`,
      [f.tenantId],
    );

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-old-gone", true, []))).status).toBe(200);
    expect((await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-replacement-takes-slot",
      true,
      [makePrinter("hb-replacement")],
    ))).status).toBe(200);
    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-all-gone", true, []))).status).toBe(200);

    const reappearance = await heartbeat(f.agentAuth, snapshotHeartbeat(
      "snap-old-back-after-free",
      true,
      [makePrinter(f.printerId)],
    ));
    expect(reappearance.status).toBe(200);
    expect(await reappearance.json()).toMatchObject({ skippedPrinters: [] });

    const rows = await pool().query(
      `SELECT id, inventory_present
       FROM printers
       WHERE tenant_id = $1 AND id = ANY($2::text[])
       ORDER BY id`,
      [f.tenantId, [f.printerId, "hb-replacement"]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.printerId, inventory_present: true }),
      expect.objectContaining({ id: "hb-replacement", inventory_present: false }),
    ]));
    expect(rows.rows.filter((row) => row.inventory_present)).toHaveLength(1);
  });
  it("rejects new print admission after a complete snapshot confirms the printer absent", async () => {
    const f = await seedFixture();

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-absent-enqueue", true, []))).status).toBe(200);

    const response = await printJobsPOST(printJobRequest(f.odooKey, f.printerId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PRINTER_UNAVAILABLE" });

    const jobs = await pool().query(
      `SELECT COUNT(*)::int AS count FROM print_jobs WHERE tenant_id = $1 AND printer_id = $2`,
      [f.tenantId, f.printerId],
    );
    expect(jobs.rows[0].count).toBe(0);
  });

  it("execution-fences queued work from both poll and websocket claims once inventory is confirmed absent", async () => {
    const f = await seedFixture();
    const jobId = `job_inventory_fence_${Date.now()}`;
    await insertQueuedJob(f, jobId);

    expect((await heartbeat(f.agentAuth, snapshotHeartbeat("snap-absent-claim", true, []))).status).toBe(200);

    const poll = await agentJobsGET(new Request("http://gateway.test/api/agent/jobs", {
      headers: { authorization: f.agentAuth },
    }));
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual([]);

    const websocketClaim = await claimJobForDelivery(jobId, f.agentId);
    expect(websocketClaim).toBeNull();

    const row = await jobRow(jobId);
    expect(row.status).toBe("queued");
    expect(row.claim_token).toBeNull();
    expect(row.delivery_attempts).toBe(0);
  });

});
