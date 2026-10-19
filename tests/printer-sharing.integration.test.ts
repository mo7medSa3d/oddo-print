import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as heartbeatPOST } from "../src/app/api/agent/heartbeat/route";
import { GET as printersGET } from "../src/app/api/printers/route";
import { GET as printerGET } from "../src/app/api/printers/[id]/route";
import { GET as odooPrintersGET } from "../src/app/api/odoo/printers/route";
import { POST as printPOST, GET as printGET } from "../src/app/api/print/jobs/route";
import { GET as pollGET, PATCH as statusPATCH } from "../src/app/api/agent/jobs/route";
import { claimJobForDelivery, markJobDelivered } from "../src/lib/job-delivery";
import { loadDashboardStateForTenant } from "../src/lib/dashboard-state";
import { getPrinterCapabilityPage, getPrinterCapabilityMatrix } from "../src/lib/printer-health";
import { getAgentHealth, getAllAgentsHealth } from "../src/lib/agent-health";
import { PATCH as printerPATCH } from "../src/app/api/printers/[id]/route";
import { createManagerSession } from "../src/lib/manager-auth";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { PRINTER_NOT_SHARED_PAUSE } from "../src/lib/job-status";
import { applyMigrations, closePool, hasTestDatabase, insertQueuedJob, jobRow, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("local-owner printer sharing across Gateway/Odoo boundaries", () => {
  let f: Fixture;
  let version: number;
  const priorSigningKey = process.env.GATEWAY_JWT_SECRET;
  beforeAll(async () => { process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey(); await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); version = 0; });
  afterAll(async () => {
    await closePool();
    if (priorSigningKey === undefined) delete process.env.GATEWAY_JWT_SECRET;
    else process.env.GATEWAY_JWT_SECRET = priorSigningKey;
  });

  const sharedObservation = () => ({ id: f.printerId, name: "Actual Windows Queue", connectionType: "spooler", protocol: "spooler", status: "online", sharedWithGateway: true,
    config: { spooler_name: "Actual Windows Queue", address: "Actual Windows Queue" }, capabilities: { supported_protocols: ["raw", "escpos", "pdf", "image"] } });
  const heartbeat = (body: Record<string, unknown>) => heartbeatPOST(new Request("https://gateway.test/api/agent/heartbeat", {
    method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
    body: JSON.stringify({ status: "online", heartbeatPage: 1, heartbeatPageCount: 1, inventorySnapshotId: `share-${++version}`, inventorySnapshotVersion: String(version), inventoryComplete: true, ...body }),
  }));
  const setPrivate = () => pool().query("UPDATE printers SET shared_with_gateway = false WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.printerId]);
  const printerRow = async () => (await pool().query("SELECT * FROM printers WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.printerId])).rows[0];
  const submit = (key: string) => printPOST(new Request("https://gateway.test/api/print/jobs", {
    method: "POST", headers: { "x-api-key": f.odooKey, "content-type": "application/json" },
    body: JSON.stringify({ printerId: f.printerId, documentType: "receipt", destination: f.destination, idempotencyKey: key,
      payload: { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" } }),
  }));
  const status = (jobId: string, next: string, claimToken: string, reason?: string) => statusPATCH(new Request("https://gateway.test/api/agent/jobs", {
    method: "PATCH", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
    body: JSON.stringify({ jobId, status: next, claimToken, reason }),
  }));

  it("forward migration preserves legacy sharing without changing printer lifecycle", async () => {
    expect(await printerRow()).toMatchObject({ shared_with_gateway: true, lifecycle: "active", status: "online" });
    const column = await pool().query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'printers' AND column_name = 'shared_with_gateway'");
    expect(column.rows).toEqual([expect.objectContaining({ is_nullable: "NO", column_default: "true" })]);
  });

  it("private IDs preserve canonical manager identity/lifecycle and never adopt private names", async () => {
    const other = await seedFixture();
    await pool().query("INSERT INTO agents (id,tenant_id,name) VALUES ('same-tenant-foreign-agent',$1,'Other workstation')", [f.tenantId]);
    await pool().query("INSERT INTO printers (id,tenant_id,agent_id,name) VALUES ('same-tenant-foreign-printer',$1,'same-tenant-foreign-agent','Other queue')", [f.tenantId]);
    await pool().query("UPDATE printers SET management_source = 'manager', desired_revision = 7, lifecycle = 'disabled' WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.printerId]);
    const before = await printerRow();
    const response = await heartbeat({ privatePrinterIds: [f.printerId, other.printerId, "same-tenant-foreign-printer", "unknown-private"], printers: [
      { ...sharedObservation(), name: "Private Name Must Not Be Adopted" },
      { ...sharedObservation(), id: "unknown-private", name: "Secret Private Device" },
    ] });
    expect(response.status).toBe(200);
    const after = await printerRow();
    expect(after).toMatchObject({ shared_with_gateway: false, lifecycle: "disabled", management_source: "manager", desired_revision: "7", name: before.name, status: before.status });
    expect(after.last_seen_at).toEqual(before.last_seen_at);
    expect((await pool().query("SELECT shared_with_gateway FROM printers WHERE tenant_id = $1 AND id = $2", [other.tenantId, other.printerId])).rows[0].shared_with_gateway).toBe(true);
    expect((await pool().query("SELECT shared_with_gateway FROM printers WHERE id='same-tenant-foreign-printer'")).rows[0].shared_with_gateway).toBe(true);
    expect((await pool().query("SELECT id FROM printers WHERE id = 'unknown-private'")).rows).toEqual([]);
  });

  it("missing legacy sharing field cannot undo denial or mark the known private device absent", async () => {
    const before = await printerRow();
    expect((await heartbeat({ privatePrinterIds: [f.printerId], printers: [] })).status).toBe(200);
    expect(await printerRow()).toMatchObject({ shared_with_gateway: false, inventory_present: true });
    const { sharedWithGateway: _sharing, ...legacy } = sharedObservation();
    expect((await heartbeat({ printers: [legacy] })).status).toBe(200);
    expect(await printerRow()).toMatchObject({ shared_with_gateway: false, lifecycle: before.lifecycle });
  });

  it("rejects stale snapshots before a negative or positive sharing policy can be applied", async () => {
    expect((await heartbeat({ privatePrinterIds: [f.printerId] })).status).toBe(200);
    const stale = await heartbeat({ inventorySnapshotVersion: "1", printers: [sharedObservation()] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "INVENTORY_SNAPSHOT_CONFLICT" });
    expect((await printerRow()).shared_with_gateway).toBe(false);
    expect((await heartbeat({ printers: [sharedObservation()] })).status).toBe(200);
    const oldDenial = await heartbeat({ inventorySnapshotVersion: "1", privatePrinterIds: [f.printerId] });
    expect(oldDenial.status).toBe(409);
    expect((await printerRow()).shared_with_gateway).toBe(true);
  });

  it("denial wins across different pages of the same version in either order", async () => {
    for (const denialFirst of [true, false]) {
      const snapshotVersion = denialFirst ? "100" : "200";
      const snapshot = { inventorySnapshotId: `ordered-${snapshotVersion}`, inventorySnapshotVersion: snapshotVersion, heartbeatPageCount: 3 };
      expect((await heartbeat({ ...snapshot, heartbeatPage: 1, ...(denialFirst ? { privatePrinterIds: [f.printerId] } : { printers: [sharedObservation()] }) })).status).toBe(200);
      expect((await heartbeat({ ...snapshot, heartbeatPage: 2, ...(denialFirst ? { printers: [sharedObservation()] } : { privatePrinterIds: [f.printerId] }) })).status).toBe(200);
      expect((await heartbeat({ ...snapshot, heartbeatPage: 3, printers: [sharedObservation()] })).status).toBe(200);
      expect(await printerRow()).toMatchObject({ shared_with_gateway: false, shared_with_gateway_version: snapshotVersion });
    }
    expect((await heartbeat({ inventorySnapshotVersion: "201", printers: [sharedObservation()] })).status).toBe(200);
    expect(await printerRow()).toMatchObject({ shared_with_gateway: true, shared_with_gateway_version: "201" });
  });

  it.each([{ privatePrinterIds: [] }, { privatePrinterIds: ["unknown"] }, { printers: [{ sharedWithGateway: true }] }])("rejects unversioned sharing controls before database mutation %s", async (body) => {
    const before = await printerRow();
    const response = await heartbeatPOST(new Request("https://gateway.test/api/agent/heartbeat", {
      method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect(await printerRow()).toEqual(before);
    expect((await pool().query("SELECT inventory_snapshot_version FROM agents WHERE tenant_id=$1 AND id=$2", [f.tenantId, f.agentId])).rows[0].inventory_snapshot_version).toBe("0");
  });

  it("manager rename/lifecycle intent cannot override the local denial", async () => {
    expect((await heartbeat({ privatePrinterIds: [f.printerId] })).status).toBe(200);
    const session = await createManagerSession(f.tenantId);
    const patch = (body: Record<string, unknown>) => printerPATCH(new Request(`https://gateway.test/api/printers/${f.printerId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: f.printerId }) });
    expect((await patch({ name: "Manager renamed queue", lifecycle: "active" })).status).toBe(200);
    expect(await printerRow()).toMatchObject({ shared_with_gateway: false, management_source: "manager", name: "Manager renamed queue" });
    expect((await patch({ sharedWithGateway: true })).status).toBe(400);
    expect((await printerRow()).shared_with_gateway).toBe(false);
  });

  it.each([null, "private", [false], [""], ["x".repeat(121)], Array(501).fill("id")])("rejects malformed/unbounded private ID pages %s", async (ids) => {
    const response = await heartbeat({ privatePrinterIds: ids });
    expect(response.status).toBe(400);
    expect((await printerRow()).shared_with_gateway).toBe(true);
  });

  it("rejects false observations instead of auto-registering private metadata", async () => {
    const response = await heartbeat({ printers: [{ ...sharedObservation(), id: "private-new", sharedWithGateway: false }] });
    expect(response.status).toBe(200);
    expect((await response.json()).skippedPrinters).toContainEqual({ id: "private-new", reason: "invalid_shared_with_gateway" });
    expect((await pool().query("SELECT id FROM printers WHERE id = 'private-new'")).rows).toEqual([]);
  });

  it("enforces capacity on re-sharing a manager-owned private row without changing disabled lifecycle", async () => {
    await pool().query("UPDATE plans SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb) WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)", [f.tenantId]);
    await pool().query("UPDATE printers SET shared_with_gateway = false, management_source = 'manager', lifecycle = 'disabled' WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.printerId]);
    await pool().query("INSERT INTO printers (id,tenant_id,agent_id,name) VALUES ('capacity-owner',$1,$2,'Existing shared printer')", [f.tenantId, f.agentId]);
    const blocked = await heartbeat({ printers: [sharedObservation()] });
    expect(blocked.status).toBe(200);
    expect((await blocked.json()).skippedPrinters).toContainEqual({ id: f.printerId, reason: "max_printers_exceeded" });
    expect(await printerRow()).toMatchObject({ shared_with_gateway: false, lifecycle: "disabled" });
    await pool().query("DELETE FROM printers WHERE tenant_id=$1 AND id='capacity-owner'", [f.tenantId]);
    expect((await heartbeat({ printers: [sharedObservation()] })).status).toBe(200);
    expect(await printerRow()).toMatchObject({ shared_with_gateway: true, lifecycle: "disabled", management_source: "manager" });
  });

  it("withdraws private policy even when billing access blocks inventory admission", async () => {
    await pool().query("UPDATE tenant_subscriptions SET status='cancelled' WHERE tenant_id=$1", [f.tenantId]);
    expect((await heartbeat({ privatePrinterIds: [f.printerId], printers: [] })).status).toBe(200);
    expect((await printerRow()).shared_with_gateway).toBe(false);
  });

  it("hides private printers from cloud lists/Odoo/current/Saved counts but retains authorized ID history", async () => {
    await setPrivate();
    const list = await printersGET(new Request("https://gateway.test/api/printers", { headers: { Authorization: f.agentAuth } }));
    expect(list.status).toBe(200); expect(await list.json()).toEqual([]);
    const odoo = await odooPrintersGET(new Request("https://gateway.test/api/odoo/printers", { headers: { "x-api-key": f.odooKey } }));
    expect(odoo.status).toBe(200); expect((await odoo.json()).printers).toEqual([]);
    const detail = await printerGET(new Request("https://gateway.test/api/printers/id", { headers: { Authorization: f.agentAuth } }), { params: Promise.resolve({ id: f.printerId }) });
    expect(detail.status).toBe(200); expect(await detail.json()).toMatchObject({ id: f.printerId, sharedWithGateway: false });
    for (const printerStatus of ["all", "saved"] as const) {
      const fleet = await loadDashboardStateForTenant(f.tenantId, { printerStatus });
      expect(fleet.printers).toEqual([]);
      expect(fleet.fleet).toMatchObject({ totalPrinters: 0, savedPrinters: 0, onlinePrinters: 0 });
      expect(fleet.agents[0]).toMatchObject({ printerCount: 0, currentPrinterCount: 0 });
    }
    expect((await getPrinterCapabilityPage(f.tenantId)).items).toEqual([]);
    expect(await getPrinterCapabilityMatrix(f.tenantId, f.printerId)).toMatchObject({ sharedWithGateway: false });
    expect(await getAgentHealth(f.tenantId, f.agentId)).toMatchObject({ printerCount: 0 });
    expect((await getAllAgentsHealth(f.tenantId)).find((a) => a.agentId === f.agentId)).toMatchObject({ printerCount: 0 });
  });

  it("refuses new Odoo admission before creating a job or charging a print credit", async () => {
    await setPrivate();
    const response = await submit("new-private-job");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PRINTER_NOT_SHARED", retryable: false });
    expect((await pool().query("SELECT id FROM print_jobs WHERE tenant_id=$1", [f.tenantId])).rows).toEqual([]);
    expect((await pool().query("SELECT * FROM print_usage_periods WHERE tenant_id=$1", [f.tenantId])).rows).toEqual([]);
  });

  it("preserves the original idempotent admission and status lookup after unsharing", async () => {
    const accepted = await submit("accepted-before-private");
    expect(accepted.status).toBe(201);
    const original = await accepted.json(); await setPrivate();
    const replay = await submit("accepted-before-private");
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ jobId: original.jobId });
    const lookup = await printGET(new Request(`https://gateway.test/api/print/jobs?id=${original.jobId}`, { headers: { "x-api-key": f.odooKey } }));
    expect(lookup.status).toBe(200); expect(await lookup.json()).toMatchObject({ jobId: original.jobId, status: "queued" });
    expect((await pool().query("SELECT id FROM print_jobs WHERE tenant_id=$1", [f.tenantId])).rows).toHaveLength(1);
  });

  it("blocks both WS claim and polling without discarding a private queued job", async () => {
    await insertQueuedJob(f, "private-queued"); await setPrivate();
    expect(await claimJobForDelivery("private-queued", f.agentId)).toBeNull();
    const poll = await pollGET(new Request("https://gateway.test/api/agent/jobs", { headers: { Authorization: f.agentAuth } }));
    expect(poll.status).toBe(200); expect(await poll.json()).toEqual([]);
    expect(await jobRow("private-queued")).toMatchObject({ status: "queued", delivery_attempts: 0, retries: 0 });
  });

  it("pauses a zero-byte local rejection before private heartbeat and resumes only on fresh explicit permission", async () => {
    await insertQueuedJob(f, "local-private-before-heartbeat");
    const claim = await claimJobForDelivery("local-private-before-heartbeat", f.agentId);
    expect(claim?.claimToken).toBeTruthy();
    await markJobDelivered(claim!.id, f.tenantId, f.agentId, claim!.claimToken!);
    const before = await jobRow(claim!.id);
    const rejection = await status(claim!.id, "queued", claim!.claimToken!, "printer_not_shared");
    expect(rejection.status).toBe(200);
    expect(await rejection.json()).toMatchObject({ success: true, status: "queued", physicalOutcome: "not_printed" });
    expect((await printerRow()).shared_with_gateway).toBe(true);
    expect(await jobRow(claim!.id)).toMatchObject({ status: "queued", error: PRINTER_NOT_SHARED_PAUSE, retries: 1, delivery_attempts: 0 });
    const paused = async () => {
      expect(await claimJobForDelivery(claim!.id, f.agentId)).toBeNull();
      const poll = await pollGET(new Request("https://gateway.test/api/agent/jobs", { headers: { Authorization: f.agentAuth } }));
      expect(poll.status).toBe(200); expect(await poll.json()).toEqual([]);
      expect((await jobRow(claim!.id)).error).toBe(PRINTER_NOT_SHARED_PAUSE);
    };
    await paused();
    const { sharedWithGateway: _sharing, ...legacy } = sharedObservation();
    expect((await heartbeat({ printers: [legacy] })).status).toBe(200); await paused();
    expect((await heartbeat({ privatePrinterIds: [f.printerId] })).status).toBe(200); await paused();
    await pool().query("UPDATE plans SET entitlements = jsonb_set(entitlements, '{max_printers}', '1'::jsonb) WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id=$1)", [f.tenantId]);
    await pool().query("INSERT INTO printers (id,tenant_id,agent_id,name) VALUES ('pause-capacity',$1,$2,'Shared capacity owner')", [f.tenantId, f.agentId]);
    const blocked = await heartbeat({ printers: [sharedObservation()] });
    expect(blocked.status).toBe(200); expect((await blocked.json()).skippedPrinters).toContainEqual({ id: f.printerId, reason: "max_printers_exceeded" });
    await paused();
    await pool().query("DELETE FROM printers WHERE tenant_id=$1 AND id='pause-capacity'", [f.tenantId]);
    expect((await heartbeat({ printers: [sharedObservation()] })).status).toBe(200);
    expect(await jobRow(claim!.id)).toMatchObject({ status: "queued", error: null, retries: 1, delivery_attempts: 0, expires_at: before.expires_at });
    expect(await claimJobForDelivery(claim!.id, f.agentId)).not.toBeNull();
  });

  it("an equal-version positive cannot release a pause created after its earlier page", async () => {
    await insertQueuedJob(f, "equal-version-pause");
    const snapshot = { inventorySnapshotId: "positive-two-page", inventorySnapshotVersion: "50", heartbeatPageCount: 2 };
    expect((await heartbeat({ ...snapshot, heartbeatPage: 1, printers: [sharedObservation()] })).status).toBe(200);
    const claim = await claimJobForDelivery("equal-version-pause", f.agentId);
    expect(claim?.claimToken).toBeTruthy();
    expect((await status(claim!.id, "queued", claim!.claimToken!, "printer_not_shared")).status).toBe(200);
    expect((await heartbeat({ ...snapshot, heartbeatPage: 2, printers: [sharedObservation()] })).status).toBe(200);
    expect(await claimJobForDelivery(claim!.id, f.agentId)).toBeNull();
    expect((await jobRow(claim!.id)).error).toBe(PRINTER_NOT_SHARED_PAUSE);
    expect((await heartbeat({ inventorySnapshotVersion: "51", printers: [sharedObservation()] })).status).toBe(200);
    expect((await jobRow(claim!.id)).error).toBeNull();
  });

  it("rejects claimed-to-printing when local sharing changed after delivery", async () => {
    await insertQueuedJob(f, "claim-before-private");
    const claim = await claimJobForDelivery("claim-before-private", f.agentId);
    expect(claim?.claimToken).toBeTruthy();
    await markJobDelivered(claim!.id, f.tenantId, f.agentId, claim!.claimToken!); await setPrivate();
    expect((await status(claim!.id, "printing", claim!.claimToken!)).status).toBe(409);
    expect((await jobRow(claim!.id)).status).toBe("claimed");
  });

  it("retains terminal reconciliation and paper UNKNOWN for already-printing work after unsharing", async () => {
    await insertQueuedJob(f, "printing-before-private");
    const claim = await claimJobForDelivery("printing-before-private", f.agentId);
    expect(claim?.claimToken).toBeTruthy();
    await markJobDelivered(claim!.id, f.tenantId, f.agentId, claim!.claimToken!);
    expect((await status(claim!.id, "printing", claim!.claimToken!)).status).toBe(200);
    expect((await status(claim!.id, "queued", claim!.claimToken!, "printer_not_shared")).status).toBe(409);
    expect((await heartbeat({ privatePrinterIds: [f.printerId], printers: [] })).status).toBe(200);
    const terminal = await status(claim!.id, "success", claim!.claimToken!);
    expect(terminal.status).toBe(200); expect(await terminal.json()).toMatchObject({ status: "success", physicalOutcome: "unknown" });
    expect((await jobRow(claim!.id)).status).toBe("success");
  });
});
