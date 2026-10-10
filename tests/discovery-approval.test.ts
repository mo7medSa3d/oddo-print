import { gatewayTestSigningKey } from "./helpers/test-secrets";
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
import { createManagerSession } from "../src/lib/manager-auth";
import { POST as discoveryReportPOST } from "../src/app/api/agent/discovery/route";
import { POST as discoveryStartPOST } from "../src/app/api/agents/[id]/discovery/route";
import { POST as discoveryCancelPOST } from "../src/app/api/agents/[id]/discovery/[discoveryId]/cancel/route";
import { POST as verifyPOST } from "../src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route";
import { GET as discoverySessionGET } from "../src/app/api/agents/[id]/discovery/[discoveryId]/route";
import { POST as provisionPOST } from "../src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("discovery trust and approval flow", () => {
  let f: Fixture;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
    delete process.env.GATEWAY_JWT_SECRET;
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  async function createDiscoverySession(id = `disc_${Date.now()}`) {
    await pool().query(
      `INSERT INTO discovery_sessions (id, tenant_id, agent_id, status, config, stats)
       VALUES ($1, $2, $3, 'running', '{}'::jsonb, '{}'::jsonb)`,
      [id, f.tenantId, f.agentId],
    );
    return id;
  }

  function agentRequest(discoveryId: string, devices: unknown[]) {
    return discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ discoveryId, status: "completed", devices }),
    }));
  }

  async function managerRequest(token: string, path: string) {
    return new Request(`http://gateway.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function observationApprovalRequest(token: string, discoveryId: string, deviceId: string) {
    const response = await discoverySessionGET(new Request(`http://gateway.test/api/agents/${f.agentId}/discovery/${discoveryId}`, {
      method: "GET", headers: { Authorization: `Bearer ${token}` },
    }), { params: Promise.resolve({ id: f.agentId, discoveryId }) });
    if (response.status !== 200) throw new Error(`Discovery GET failed: ${response.status}`);
    const payload = await response.json();
    const observation = payload.devices.find((d: { id: string }) => d.id === deviceId);
    if (!observation?.observationFingerprint) throw new Error("No matching immutable discovery observation");
    return new Request(`http://gateway.test/api/agents/${f.agentId}/discovered-printers/${deviceId}/verify`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "If-Match": `"${observation.observationFingerprint}"` },
    });
  }

  it("expires an abandoned empty discovery before admitting a new scan", async () => {
    const priorId = await createDiscoverySession("disc-abandoned-empty");
    await pool().query("UPDATE discovery_sessions SET updated_at = now() - interval '11 minutes' WHERE id = $1", [priorId]);
    const manager = await createManagerSession(f.tenantId);
    const nextScan = await discoveryStartPOST(new Request(`http://gateway.test/api/agents/${f.agentId}/discovery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${manager.token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 30_000 }),
    }), { params: Promise.resolve({ id: f.agentId }) });
    expect(nextScan.status).toBe(201);
    const old = await pool().query("SELECT status, completed_at, stats FROM discovery_sessions WHERE id = $1", [priorId]);
    expect(old.rows[0].status).toBe("failed");
    expect(old.rows[0].completed_at).toBeTruthy();
    expect(old.rows[0].stats.errors).toContain("Discovery report abandoned: no progress for 10 minutes");
    const active = await pool().query("SELECT id FROM discovery_sessions WHERE agent_id = $1 AND status = 'running'", [f.agentId]);
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0].id).not.toBe(priorId);
  });

  it("preserves observations and marks abandoned partially reported discovery as partial", async () => {
    const discoveryId = await createDiscoverySession("disc-abandoned-partial");
    const firstPage = await discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ discoveryId, status: "running", chunkIndex: 0, chunkCount: 2, totalCandidates: 2,
        devices: [{ id: "persisted-partial-device", stableId: "stale-partial", protocol: "ipp", ipAddress: "192.168.1.45", port: 631 }] }),
    }));
    expect(firstPage.status).toBe(200);
    await pool().query("UPDATE discovery_sessions SET updated_at = now() - interval '11 minutes' WHERE id = $1", [discoveryId]);
    const manager = await createManagerSession(f.tenantId);
    const view = await discoverySessionGET(new Request(`http://gateway.test/api/agents/${f.agentId}/discovery/${discoveryId}`, {
      method: "GET", headers: { Authorization: `Bearer ${manager.token}` },
    }), { params: Promise.resolve({ id: f.agentId, discoveryId }) });
    expect(view.status).toBe(200);
    const body = await view.json();
    expect(body.session.status).toBe("partial");
    expect(body.devices.some((device: { id: string }) => device.id === "persisted-partial-device")).toBe(true);
    const continued = await discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ discoveryId, status: "completed", chunkIndex: 1, chunkCount: 2, devices: [] }),
    }));
    expect(continued.status).toBe(409);
  });

  it("accepts bounded discovery pages in order and handles a lost final acknowledgment", async () => {
    const discoveryId = await createDiscoverySession("disc-paged-ack-retry");
    const sendPage = (chunkIndex: number, status: string, devices: unknown[]) => discoveryReportPOST(
      new Request("http://gateway.test/api/agent/discovery", {
        method: "POST",
        headers: { Authorization: f.agentAuth, "content-type": "application/json" },
        body: JSON.stringify({ discoveryId, chunkIndex, chunkCount: 2, totalCandidates: 2, status, devices }),
      }),
    );
    const page0 = [{ id: "paged-dev-a", stableId: "stable-a", protocol: "ipp", ipAddress: "192.168.5.1", port: 631 }];
    const page1 = [{ id: "paged-dev-b", stableId: "stable-b", protocol: "ipp", ipAddress: "192.168.5.2", port: 631 }];
    // Later chunks must not bypass the sequence fence or finalize the session.
    expect((await sendPage(1, "completed", page1)).status).toBe(409);
    expect((await sendPage(0, "running", page0)).status).toBe(200);
    const inProgress = await pool().query("SELECT status, stats FROM discovery_sessions WHERE id = $1", [discoveryId]);
    expect(inProgress.rows[0].status).toBe("running");
    expect(inProgress.rows[0].stats.acceptedChunks).toEqual([0]);
    expect(inProgress.rows[0].stats.candidates).toBe(2);
    // Retrying a previously committed chunk does not duplicate changes/stats.
    expect((await sendPage(0, "running", page0)).status).toBe(200);
    expect((await sendPage(1, "completed", page1)).status).toBe(200);
    const finished = await pool().query("SELECT status, stats FROM discovery_sessions WHERE id = $1", [discoveryId]);
    expect(finished.rows[0].status).toBe("completed");
    expect(finished.rows[0].stats.acceptedChunks).toEqual([0, 1]);
    expect(finished.rows[0].stats.inserted).toBe(2);
    // The terminal response may be lost on the network. The Agent resends
    // the final page, and the Gateway must acknowledge its durable commit.
    expect((await sendPage(1, "completed", page1)).status).toBe(200);
    expect((await sendPage(0, "running", page0)).status).toBe(200);
    const afterReplay = await pool().query("SELECT status, stats FROM discovery_sessions WHERE id = $1", [discoveryId]);
    expect(afterReplay.rows[0]).toEqual(finished.rows[0]);
    const observations = await pool().query("SELECT id FROM discovered_devices WHERE tenant_id = $1 AND agent_id = $2", [f.tenantId, f.agentId]);
    expect(observations.rows.map((row: { id: string }) => row.id).sort()).toEqual(["paged-dev-a", "paged-dev-b"]);
  });

  it("rejects a changed replay of an acknowledged page without altering persisted observations", async () => {
    const discoveryId = await createDiscoverySession("disc-mutated-page-replay");
    const payload = (ipAddress: string) => ({ discoveryId, status: "completed", chunkIndex: 0, chunkCount: 1,
      totalCandidates: 1, errors: [], devices: [{ id: "replay-immutable", stableId: "replay-immutable",
        protocol: "ipp", ipAddress, port: 631 }] });
    const send = (ipAddress: string) => discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify(payload(ipAddress)),
    }));
    expect((await send("192.168.4.8")).status).toBe(200);
    const committed = await pool().query("SELECT stats FROM discovery_sessions WHERE id = $1", [discoveryId]);
    expect(committed.rows[0].stats.chunkDigests).toHaveLength(1);
    // Identical committed pages, including the terminal page, are retry-safe.
    expect((await send("192.168.4.8")).status).toBe(200);
    const different = await send("192.168.4.9");
    expect(different.status).toBe(409);
    expect((await different.json()).code).toBe("DISCOVERY_CHUNK_REPLAY_CHANGED");
    expect((await pool().query("SELECT stats FROM discovery_sessions WHERE id = $1", [discoveryId])).rows[0].stats)
      .toEqual(committed.rows[0].stats);
    const persisted = await pool().query("SELECT ip_address FROM discovered_devices WHERE id = $1", ["replay-immutable"]);
    expect(persisted.rows[0].ip_address).toBe("192.168.4.8");
  });

  it("does not hold a discovery-session lock while waiting for an Agent lifecycle writer", async () => {
    const discoveryId = await createDiscoverySession("disc-lock-order-fence");
    const lockHolder = await pool().connect();
    let pending: Promise<Response> | undefined;
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [f.agentId]);
      pending = discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
        method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
        body: JSON.stringify({ discoveryId, status: "completed", devices: [] }),
      }));
      // A concurrent reporter must acquire an Agent lock before the session
      // row; otherwise it can deadlock against a manager's session expiry.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const probeClient = await pool().connect();
      try {
        await probeClient.query("BEGIN");
        const probe = await probeClient.query("SELECT id FROM discovery_sessions WHERE id = $1 FOR UPDATE NOWAIT", [discoveryId]);
        expect(probe.rowCount).toBe(1);
      } finally {
        await probeClient.query("ROLLBACK");
        probeClient.release();
      }
    } finally {
      await lockHolder.query("ROLLBACK");
      lockHolder.release();
    }
    expect((await pending!).status).toBe(200);
  });

  it("does not acknowledge a forged future discovery chunk or a conflicting page count", async () => {
    const discoveryId = await createDiscoverySession("disc-paged-conflict");
    const send = (chunkIndex: number, chunkCount: number) => discoveryReportPOST(
      new Request("http://gateway.test/api/agent/discovery", {
        method: "POST",
        headers: { Authorization: f.agentAuth, "content-type": "application/json" },
        body: JSON.stringify({ discoveryId, status: "running", chunkIndex, chunkCount, devices: [] }),
      }),
    );
    const earlyCompletion = await discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ discoveryId, status: "completed", chunkIndex: 0, chunkCount: 2, devices: [] }),
    }));
    expect(earlyCompletion.status).toBe(400);
    expect((await send(0, 2)).status).toBe(200);
    expect((await send(1, 3)).status).toBe(409);
    expect((await send(2, 3)).status).toBe(409);
    const result = await pool().query("SELECT status, stats FROM discovery_sessions WHERE id = $1", [discoveryId]);
    expect(result.rows[0].status).toBe("running");
    expect(result.rows[0].stats.acceptedChunks).toEqual([0]);
    expect(result.rows[0].stats.chunkCount).toBe(2);
  });

  it("treats agent verification/confidence as untrusted observation data", async () => {
    const discoveryId = await createDiscoverySession();
    const res = await agentRequest(discoveryId, [{
      id: "device-trust-1", source: ["ipp"], protocol: "ipp", ipAddress: "192.168.10.44", port: 631,
      verification: "verified", confidence: "high", capabilities: { supported_protocols: ["pdf"] },
    }]);

    expect(res.status).toBe(200);
    const row = await pool().query(
      `SELECT verification, confidence, candidate_status FROM discovered_devices WHERE id = $1`,
      ["device-trust-1"],
    );
    expect(row.rows[0]).toEqual({ verification: "candidate", confidence: "low", candidate_status: "discovered" });
  });

  it("rejects public IPv6 discovery reports at the Gateway boundary", async () => {
    const discoveryId = await createDiscoverySession();
    const res = await agentRequest(discoveryId, [{ id: "device-public-v6", protocol: "ipp", ipAddress: "2001:4860:4860::8888", port: 631 }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("private or link-local");
  });

  it("requires explicit manager approval before provisioning", async () => {
    const discoveryId = await createDiscoverySession();
    await agentRequest(discoveryId, [{
      id: "device-provision-1", source: ["ipp"], protocol: "ipp", ipAddress: "192.168.10.50", port: 631,
      uri: "ipp://192.168.10.50/ipp/print", deviceName: "Approved Printer",
    }]);

    const manager = await createManagerSession(f.tenantId);
    const unapproved = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-provision-1/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-provision-1" }) } as any,
    );
    expect(unapproved.status).toBe(409);
    expect((await unapproved.json()).code).toBe("DEVICE_NOT_APPROVED");

    const verify = await verifyPOST(
      await observationApprovalRequest(manager.token, discoveryId, "device-provision-1"),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-provision-1" }) } as any,
    );
    expect(verify.status).toBe(200);

    const provision = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-provision-1/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-provision-1" }) } as any,
    );
    expect(provision.status).toBe(201);

    const body = await provision.json();
    const printer = await pool().query(`SELECT agent_id, lifecycle, status, protocol, config FROM printers WHERE id = $1`, [body.printerId]);
    expect(printer.rows[0]).toMatchObject({ agent_id: f.agentId, lifecycle: "active", status: "unknown", protocol: "ipp" });
    expect(printer.rows[0].config).toMatchObject({ address: "ipp://192.168.10.50/ipp/print" });

    const device = await pool().query(`SELECT verification, confidence, candidate_status, provisioned_printer_id FROM discovered_devices WHERE id = $1`, ["device-provision-1"]);
    expect(device.rows[0].verification).toBe("verified");
    expect(device.rows[0].confidence).toBe("low");
    expect(device.rows[0].candidate_status).toBe("provisioned");
    expect(device.rows[0].provisioned_printer_id).toBe(body.printerId);
  });

  it("provisions a verified Windows spooler candidate with a routable queue config", async () => {
    const discoveryId = await createDiscoverySession();
    await agentRequest(discoveryId, [{
      id: "device-spooler-1", source: ["windows_spooler"], protocol: "spooler",
      deviceName: "HP LaserJet Enterprise", verification: "verified", confidence: "high",
    }]);

    const manager = await createManagerSession(f.tenantId);
    const verify = await verifyPOST(
      await observationApprovalRequest(manager.token, discoveryId, "device-spooler-1"),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-spooler-1" }) } as any,
    );
    expect(verify.status).toBe(200);

    const provision = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-spooler-1/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-spooler-1" }) } as any,
    );
    expect(provision.status).toBe(201);
    const body = await provision.json();
    const printer = await pool().query(`SELECT connection_type, protocol, config FROM printers WHERE id = $1`, [body.printerId]);
    expect(printer.rows[0]).toMatchObject({ connection_type: "spooler", protocol: "spooler" });
    expect(printer.rows[0].config).toMatchObject({ spooler_name: "HP LaserJet Enterprise", address: "HP LaserJet Enterprise" });
  });

  it("refuses to provision an LPR-only candidate as raw (LAW: no heuristic protocol inference)", async () => {

    // An LPR probe only proves TCP 515 accepts connections. The LPD daemon
    // there does not consume a raw byte stream, so mapping lpr -> raw would
    // write raw job bytes to port 515 - the exact re-labeling the agent's
    // NormalizedProtocol refuses. Such candidates must land on the explicit
    // unsupported-transport gate, never on a silently invented protocol.
    const discoveryId = await createDiscoverySession();
    await agentRequest(discoveryId, [{
      id: "device-lpr-1", source: ["lpr"], protocol: "lpr", ipAddress: "192.168.10.77", port: 515,
      uri: "lpd://192.168.10.77", deviceName: "LPR Printer",
    }]);

    const manager = await createManagerSession(f.tenantId);
    const verify = await verifyPOST(
      await observationApprovalRequest(manager.token, discoveryId, "device-lpr-1"),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-lpr-1" }) } as any,
    );
    expect(verify.status).toBe(200);

    const provision = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-lpr-1/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-lpr-1" }) } as any,
    );
    expect(provision.status).toBe(422);
    expect((await provision.json()).code).toBe("UNSUPPORTED_DISCOVERY_TRANSPORT");

    // No printer row may exist for the LPR device under any protocol.
    const printers = await pool().query(`SELECT id, protocol FROM printers WHERE config->>'ip' = '192.168.10.77'`);
    expect(printers.rows).toEqual([]);
    const device = await pool().query(`SELECT candidate_status FROM discovered_devices WHERE id = 'device-lpr-1'`);
    expect(device.rows[0].candidate_status).not.toBe("provisioned");
  });

  it("does not adopt an existing printer using another language on the same TCP endpoint", async () => {
    const discoveryId = await createDiscoverySession("disc-language-distinct-endpoint");
    const reported = await agentRequest(discoveryId, [{
      id: "device-zpl-on-shared-socket", stableId: "observed-zpl-shared-socket",
      source: ["tcp_port_scan"], transport: "network", protocol: "zpl",
      ipAddress: "192.168.10.78", port: 9100, deviceName: "Label printer",
    }]);
    expect(reported.status).toBe(200);
    await pool().query(`
      INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, device_class,
        connection_type, protocol, status, lifecycle, management_source, config, capabilities)
      VALUES ('existing_escpos_socket', $1, $2, 'Different print language', 'physical', 'thermal',
        'network', 'escpos', 'unknown', 'active', 'manager',
        '{"ip":"192.168.10.78","port":9100}'::jsonb, '{}'::jsonb)
    `, [f.tenantId, f.agentId]);

    const manager = await createManagerSession(f.tenantId);
    const approved = await verifyPOST(
      await observationApprovalRequest(manager.token, discoveryId, "device-zpl-on-shared-socket"),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-zpl-on-shared-socket" }) } as any,
    );
    expect(approved.status).toBe(200);

    const result = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-zpl-on-shared-socket/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-zpl-on-shared-socket" }) } as any,
    );
    expect(result.status).toBe(201);
    expect((await result.json()).printerId).not.toBe("existing_escpos_socket");
    const printers = await pool().query(`SELECT protocol FROM printers WHERE tenant_id = $1 AND agent_id = $2 AND config->>'ip' = '192.168.10.78'`, [f.tenantId, f.agentId]);
    expect(new Set(printers.rows.map((row: { protocol: string }) => row.protocol))).toEqual(new Set(["escpos", "zpl"]));
  });

  it("refuses to synthesize a Windows queue from a network discovery candidate", async () => {
    const discoveryId = await createDiscoverySession("disc-network-mislabeled-spooler");
    const reported = await agentRequest(discoveryId, [{
      id: "network-spooler-conflict", stableId: "network-spooler-conflict",
      source: ["tcp_port_scan"], transport: "network", protocol: "spooler",
      ipAddress: "192.168.10.79", port: 9100, deviceName: "Not a Windows queue",
    }]);
    expect(reported.status).toBe(200);
    const manager = await createManagerSession(f.tenantId);
    const approved = await verifyPOST(
      await observationApprovalRequest(manager.token, discoveryId, "network-spooler-conflict"),
      { params: Promise.resolve({ id: f.agentId, deviceId: "network-spooler-conflict" }) } as any,
    );
    expect(approved.status).toBe(200);
    const result = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/network-spooler-conflict/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "network-spooler-conflict" }) } as any,
    );
    expect(result.status).toBe(422);
    expect((await result.json()).code).toBe("UNSUPPORTED_DISCOVERY_TRANSPORT");
    const printers = await pool().query(`SELECT id FROM printers WHERE tenant_id = $1 AND agent_id = $2`, [f.tenantId, f.agentId]);
    expect(printers.rows).toHaveLength(0);
  });

  it("report wins over a later cancellation without lifecycle inconsistency", async () => {
    const discoveryId = await createDiscoverySession("disc-report-before-cancel");
    const report = await agentRequest(discoveryId, [{
      id: "device-report-before-cancel", source: ["ipp"], protocol: "ipp", ipAddress: "192.168.10.90", port: 631,
      uri: "ipp://192.168.10.90/ipp/print", deviceName: "Race Printer",
    }]);
    expect(report.status).toBe(200);

    const manager = await createManagerSession(f.tenantId);
    const cancel = await discoveryCancelPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovery/${discoveryId}/cancel`),
      { params: Promise.resolve({ id: f.agentId, discoveryId }) } as any,
    );
    expect(cancel.status).toBe(409);

    const session = await pool().query(`SELECT status FROM discovery_sessions WHERE id = $1`, [discoveryId]);
    const devices = await pool().query(`SELECT count(*)::int AS count FROM discovered_devices WHERE discovery_id = $1`, [discoveryId]);
    expect(session.rows[0].status).toBe("completed");
    expect(devices.rows[0].count).toBe(1);
  });

  it("cancellation wins over a later report without accepting late devices", async () => {
    const discoveryId = await createDiscoverySession("disc-cancel-before-report");
    const manager = await createManagerSession(f.tenantId);
    const cancel = await discoveryCancelPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovery/${discoveryId}/cancel`),
      { params: Promise.resolve({ id: f.agentId, discoveryId }) } as any,
    );
    expect(cancel.status).toBe(200);

    const report = await agentRequest(discoveryId, [{
      id: "device-cancel-before-report", source: ["ipp"], protocol: "ipp", ipAddress: "192.168.10.91", port: 631,
      uri: "ipp://192.168.10.91/ipp/print", deviceName: "Late Printer",
    }]);
    expect(report.status).toBe(409);

    const session = await pool().query(`SELECT status FROM discovery_sessions WHERE id = $1`, [discoveryId]);
    const devices = await pool().query(`SELECT count(*)::int AS count FROM discovered_devices WHERE discovery_id = $1`, [discoveryId]);
    expect(session.rows[0].status).toBe("cancelled");
    expect(devices.rows[0].count).toBe(0);
  });


  it("converges repeated discovery scans on one stable device identity", async () => {
    const firstDiscovery = await createDiscoverySession("disc-sync-first");
    const first = await agentRequest(firstDiscovery, [{
      id: "dev_agent_scoped_1", stableId: "printer_net_abcdef", source: ["raw"], protocol: "raw",
      ipAddress: "192.168.10.60", port: 9100, deviceName: "Receipt A",
    }]);
    expect(first.status).toBe(200);
    expect((await first.json()).inserted).toBe(1);

    const secondDiscovery = await createDiscoverySession("disc-sync-second");
    const second = await agentRequest(secondDiscovery, [{
      id: "dev_agent_scoped_1", stableId: "printer_net_abcdef", source: ["raw", "snmp"], protocol: "raw",
      ipAddress: "192.168.10.60", port: 9100, deviceName: "Receipt Renamed",
    }]);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.inserted).toBe(0);
    expect(secondBody.updated).toBe(1);

    const rows = await pool().query(
      `SELECT id, discovery_id, identity_key, device_name FROM discovered_devices
       WHERE tenant_id = $1 AND agent_id = $2`,
      [f.tenantId, f.agentId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: "dev_agent_scoped_1",
      discovery_id: "disc-sync-second",
      identity_key: "printer_net_abcdef",
      device_name: "Receipt Renamed",
    });
  });

  it("allows two tenants to report the same discovery device id", async () => {
    const other = await seedFixture();
    const sharedDeviceId = "dev_shared_net_identity";
    const discoveryA = await createDiscoverySession("disc-tenant-a-shared");
    await pool().query(
      `INSERT INTO discovery_sessions (id, tenant_id, agent_id, status, config, stats)
       VALUES ($1, $2, $3, 'running', '{}'::jsonb, '{}'::jsonb)`,
      ["disc-tenant-b-shared", other.tenantId, other.agentId],
    );

    const resA = await agentRequest(discoveryA, [{
      id: sharedDeviceId, stableId: "printer_net_shared", protocol: "raw",
      ipAddress: "192.168.1.50", port: 9100, deviceName: "Tenant A LAN",
    }]);
    expect(resA.status).toBe(200);

    const resB = await discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST",
      headers: { Authorization: other.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        discoveryId: "disc-tenant-b-shared",
        status: "completed",
        devices: [{
          id: sharedDeviceId, stableId: "printer_net_shared", protocol: "raw",
          ipAddress: "192.168.1.50", port: 9100, deviceName: "Tenant B LAN",
        }],
      }),
    }));
    expect(resB.status).toBe(200);
    expect((await resB.json()).inserted).toBe(1);

    const rows = await pool().query(
      `SELECT tenant_id, device_name FROM discovered_devices WHERE id = $1 ORDER BY tenant_id`,
      [sharedDeviceId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row: { tenant_id: string }) => row.tenant_id))).toEqual(new Set([f.tenantId, other.tenantId]));
  });

  it("deduplicates repeated device identities inside one discovery report", async () => {
    const discoveryId = await createDiscoverySession("disc-intra-batch-dedupe");
    const res = await agentRequest(discoveryId, [
      { id: "device-dup-a", stableId: "printer_net_same", protocol: "raw", ipAddress: "192.168.10.70", port: 9100, deviceName: "First Observation" },
      { id: "device-dup-b", stableId: "printer_net_same", protocol: "raw", ipAddress: "192.168.10.70", port: 9100, deviceName: "Last Observation" },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(1);

    const rows = await pool().query(
      `SELECT count(*)::int AS count, identity_key, device_name
       FROM discovered_devices WHERE tenant_id = $1 AND agent_id = $2
       GROUP BY identity_key, device_name`,
      [f.tenantId, f.agentId],
    );
    expect(rows.rows).toEqual([{ count: 1, identity_key: "printer_net_same", device_name: "Last Observation" }]);
  });
  it("accepts valid discovery devices when another candidate in the same report is invalid", async () => {
    const discoveryId = await createDiscoverySession("disc-partial-report");
    const res = await agentRequest(discoveryId, [
      { id: "device-valid-1", stableId: "printer_net_valid", protocol: "raw", ipAddress: "192.168.10.61", port: 9100, deviceName: "Valid Printer" },
      { id: "device-invalid-1", protocol: "raw", ipAddress: "8.8.8.8", port: 9100, deviceName: "Rejected Printer" },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatchObject({ id: "device-invalid-1" });

    const session = await pool().query(`SELECT status, stats FROM discovery_sessions WHERE id = $1`, [discoveryId]);
    expect(session.rows[0].status).toBe("partial");
    expect(session.rows[0].stats).toMatchObject({ candidates: 2, inserted: 1, skipped: 1 });

    const devices = await pool().query(`SELECT id FROM discovered_devices WHERE discovery_id = $1`, [discoveryId]);
    expect(devices.rows).toEqual([{ id: "device-valid-1" }]);
  });
  it("serializes concurrent provisioning so one candidate cannot create two printers", async () => {
    const discoveryId = await createDiscoverySession();
    await agentRequest(discoveryId, [{
      id: "device-concurrent-1", source: ["ipp"], protocol: "ipp", ipAddress: "192.168.10.51", port: 631,
      uri: "ipp://192.168.10.51/ipp/print", deviceName: "Concurrent Printer",
    }]);

    const manager = await createManagerSession(f.tenantId);
    const verify = await verifyPOST(
      await observationApprovalRequest(manager.token, discoveryId, "device-concurrent-1"),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-concurrent-1" }) } as any,
    );
    expect(verify.status).toBe(200);

    const [a, b] = await Promise.all([
      provisionPOST(
        await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-concurrent-1/provision`),
        { params: Promise.resolve({ id: f.agentId, deviceId: "device-concurrent-1" }) } as any,
      ),
      provisionPOST(
        await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-concurrent-1/provision`),
        { params: Promise.resolve({ id: f.agentId, deviceId: "device-concurrent-1" }) } as any,
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const count = await pool().query(
      `SELECT count(*)::int AS count FROM printers WHERE agent_id = $1 AND config->>'address' = $2`,
      [f.agentId, "ipp://192.168.10.51/ipp/print"],
    );
    expect(count.rows[0].count).toBe(1);
  });
});
