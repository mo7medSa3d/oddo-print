import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  pool,
  sha256,
} from "./helpers/pg";
import { createManagerSession } from "../src/lib/manager-auth";
import { validateAgent, hashPairingCode } from "../src/lib/agent-auth";
import { POST as registerPOST } from "../src/app/api/agent/register/route";

let currentManagerToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (currentManagerToken ? { value: currentManagerToken } : undefined),
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Import actions after mocks
import { deleteAgent, createAgent } from "../src/app/actions";
import { translate } from "../src/i18n/translate";

// Tenant contract (migrations 0028-0031): every runtime row is tenant-owned
// and agents/printers/jobs require tenant_id (NOT NULL). Fixtures carry the
// same tenant the manager session is issued for.
const TENANT_ID = "tenant_agent_deletion";

const suite = describe.skipIf(!hasTestDatabase);

suite("permanent agent deletion lifecycle & invariants", () => {
  const prevTrustProxy = process.env.TRUST_PROXY;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    process.env.MANAGER_USERNAME = "manager";
    process.env.TRUST_PROXY = "1";
    await applyMigrations();
  });

  afterAll(async () => {
    if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTrustProxy;
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    await pool().query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [TENANT_ID, "Agent Deletion Test Tenant"]);
    // Agent creation enforces entitlements fail-closed, so the fixture tenant
    // needs an eligible subscription like any real workspace.
    await pool().query(
      `INSERT INTO plans (id, name, entitlements) VALUES ('plan_agent_deletion', 'Test', '{"max_agents":"unlimited","max_printers":"unlimited","max_jobs_per_minute":"unlimited","max_concurrent_jobs":"unlimited","max_prints_per_period":"unlimited"}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await pool().query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, current_period_end) VALUES ($1, 'plan_agent_deletion', 'active', NULL) ON CONFLICT (tenant_id) DO UPDATE SET plan_id = 'plan_agent_deletion', status = 'active', current_period_end = NULL`,
      [TENANT_ID],
    );
    const session = await createManagerSession(TENANT_ID);
    currentManagerToken = session.token;
  });

  it("rejects deletion when unauthenticated or called with invalid manager token", async () => {
    currentManagerToken = null;
    await expect(deleteAgent("agt_offline_1")).rejects.toThrow(translate("en", "errors.sessionExpired"));

    currentManagerToken = "tampered.jwt.token";
    await expect(deleteAgent("agt_offline_1")).rejects.toThrow(translate("en", "errors.sessionExpired"));
  });

  it("rejects empty or whitespace agent ID", async () => {
    await expect(deleteAgent("")).rejects.toThrow(translate("en", "errors.agentIdRequired"));
    await expect(deleteAgent("   ")).rejects.toThrow(translate("en", "errors.agentIdRequired"));
    // @ts-expect-error test non-string input
    await expect(deleteAgent(null)).rejects.toThrow(translate("en", "errors.agentIdRequired"));
  });

  it("rejects deletion of a non-existent agent", async () => {
    await expect(deleteAgent("agt_non_existent")).rejects.toThrow(translate("en", "errors.agentNotFound"));
  });

  it("deletes an online agent and invalidates its credentials", async () => {
    const agentId = "agt_online_test";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, $2, 'Online Agent', $3, 'online', 'active', now())`,
      [agentId, TENANT_ID, sha256("secret123")],
    );

    await expect(deleteAgent(agentId)).resolves.toEqual({ ok: true });
    expect(await validateAgent(`Bearer ${agentId}:secret123`)).toBeNull();

    // Verify the Agent is removed and history remains independently attributable
    const row = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    expect(row).toBeUndefined();
  });

  it("allows deletion of an agent whose online status is stale", async () => {
    const agentId = "agt_stale_online";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, $2, 'Stale Online Agent', $3, 'online', 'active', now() - interval '10 minutes')`,
      [agentId, TENANT_ID, sha256("secret123")],
    );

    await expect(deleteAgent(agentId)).resolves.toEqual({ ok: true });

    const row = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    expect(row).toBeUndefined();
  });

  it("deletes a retired agent while retaining its audit event", async () => {
    const agentId = "agt_retired_test";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, $2, 'Retired Agent', $3, 'offline', 'retired', now())`,
      [agentId, TENANT_ID, sha256("secret123")],
    );

    await expect(deleteAgent(agentId)).resolves.toEqual({ ok: true });
    const audit = await pool().query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='agent.deleted'", [agentId]);
    expect(audit.rows).toHaveLength(1);

    // Verify the Agent is removed and history remains independently attributable
    const row = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    expect(row).toBeUndefined();
  });

  it("deletes Agent and printers while preserving the original operation receipt", async () => {
    const agentId = "agt_with_jobs";
    const printerId = "prn_with_jobs";
    const jobId = "job_audit_fixture";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, $2, 'Job Agent', $3, 'offline', 'active', now())`,
      [agentId, TENANT_ID, sha256("secret123")],
    );
    await pool().query(
      `INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, connection_type, protocol, status, lifecycle)
       VALUES ($1, $2, $3, 'Test Printer', 'physical', 'network', 'raw', 'offline', 'active')`,
      [printerId, TENANT_ID, agentId],
    );
    await pool().query(
      `INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, destination, status, payload, expires_at)
       VALUES ($1, $2, $3, $4, 'POS-1', 'success', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`,
      [jobId, TENANT_ID, agentId, printerId],
    );

    await expect(deleteAgent(agentId)).resolves.toEqual({ ok: true });
    const receipt = (await pool().query("SELECT status, agent_id, printer_id, fingerprint FROM print_job_receipts WHERE id=$1", [jobId])).rows[0];
    expect(receipt).toMatchObject({ status: "success", agent_id: agentId, printer_id: printerId });
    expect(receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Runtime rows are gone; the retained receipt above owns idempotency/history.
    const a = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    const p = (await pool().query(`SELECT id FROM printers WHERE id = $1`, [printerId])).rows[0];
    const j = (await pool().query(`SELECT id FROM print_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(a).toBeUndefined();
    expect(p).toBeUndefined();
    expect(j).toBeUndefined();
  });

  it("deletes an eligible offline agent with no print jobs and cleans up removable runtime records", async () => {
    const agentId = "agt_clean_eligible";
    const printerId1 = "prn_clean_1";
    const printerId2 = "prn_clean_2";
    const discoveryId = "disc_session_1";
    const deviceId = "dev_candidate_1";

    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, $2, 'Eligible Agent', $3, 'offline', 'active', now())`,
      [agentId, TENANT_ID, sha256("secret123")],
    );
    await pool().query(
      `INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, connection_type, protocol, status, lifecycle)
       VALUES ($1, $2, $3, 'Printer 1', 'physical', 'network', 'raw', 'offline', 'active'),
              ($4, $2, $3, 'Printer 2', 'physical', 'network', 'raw', 'offline', 'active')`,
      [printerId1, TENANT_ID, agentId, printerId2],
    );
    await pool().query(
      `INSERT INTO discovery_sessions (id, tenant_id, agent_id, status, config, stats)
       VALUES ($1, $2, $3, 'completed', '{}'::jsonb, '{}'::jsonb)`,
      [discoveryId, TENANT_ID, agentId],
    );
    await pool().query(
      `INSERT INTO discovered_devices (id, tenant_id, discovery_id, agent_id, protocol, provisioned_printer_id)
       VALUES ($1, $2, $3, $4, 'raw', $5)`,
      [deviceId, TENANT_ID, discoveryId, agentId, printerId1],
    );

    const result = await deleteAgent(agentId);
    expect(result).toEqual({ ok: true });

    // Verify agent and all associated runtime records are gone
    const agentRows = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows;
    expect(agentRows).toHaveLength(0);

    const printerRows = (await pool().query(`SELECT id FROM printers WHERE agent_id = $1`, [agentId])).rows;
    expect(printerRows).toHaveLength(0);

    const discRows = (await pool().query(`SELECT id FROM discovery_sessions WHERE agent_id = $1`, [agentId])).rows;
    expect(discRows).toHaveLength(0);

    const devRows = (await pool().query(`SELECT id FROM discovered_devices WHERE agent_id = $1`, [agentId])).rows;
    expect(devRows).toHaveLength(0);
  });

  it("invalidates credentials: deleted agent cannot authenticate or access endpoints", async () => {
    // Fixture ID must satisfy the production Agent ID contract
    // (agt_ + 8 chars, enforced by validateAgent via isValidAgentId).
    const agentId = "agt_authinv0";
    const rawSecret = "my-super-secret-password-123";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, $2, 'Auth Agent', $3, 'offline', 'active', now())`,
      [agentId, TENANT_ID, sha256(rawSecret)],
    );

    const authHeader = `Bearer ${agentId}:${rawSecret}`;

    // Agent authenticates successfully prior to deletion
    const validatedBefore = await validateAgent(authHeader);
    expect(validatedBefore).not.toBeNull();
    expect(validatedBefore?.id).toBe(agentId);

    // Delete agent
    await deleteAgent(agentId);

    // Agent authentication returns null (401 Unauthorized) after deletion
    const validatedAfter = await validateAgent(authHeader);
    expect(validatedAfter).toBeNull();
  });

  it("ensures old pairing code cannot be used to pair after agent deletion", async () => {
    const agentId = "agt_pairing_cleanup";
    const pairingCode = "KL77MN";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, pairing_code_hash, pairing_code_expires_at, status, lifecycle)
       VALUES ($1, $2, 'Pairing Agent', $3, now() + interval '30 minutes', 'offline', 'active')`,
      [agentId, TENANT_ID, hashPairingCode(pairingCode)],
    );

    // Delete agent before pairing code is consumed
    await deleteAgent(agentId);

    // Old pairing attempt fails
    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.88" },
      body: JSON.stringify({ pairingCode }),
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unknown, disabled, retired, or expired agent registration");
  });

  it("handles complete uninstall -> delete -> reinstall -> re-pair end-to-end flow", async () => {
    // 1. Initial Agent on Customer Windows PC
    const agentId1 = "agt_initial_pc";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle)
       VALUES ($1, $2, 'Reception PC', $3, 'offline', 'active')`,
      [agentId1, TENANT_ID, sha256("old-secret")],
    );

    // 2. Windows Agent was uninstalled from PC; Agent remains offline in Gateway
    // 3. Administrator permanently deletes the Agent from Gateway
    await deleteAgent(agentId1);

    const check1 = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId1])).rows;
    expect(check1).toHaveLength(0);

    // 4. Customer installs fresh Windows Agent app; Administrator creates new Agent
    const freshAgent = await createAgent("Reception PC Reinstalled");
    expect(typeof freshAgent.id).toBe("string");
    expect(freshAgent.id).not.toBe(agentId1);
    expect(freshAgent.pairingCode).toHaveLength(6);

    // 5. Windows Agent pairs with the new pairing code
    const registerRes = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.99" },
      body: JSON.stringify({
        pairingCode: freshAgent.pairingCode,
        metadata: { hostname: "reception-pc", os: "windows" },
      }),
    }));

    expect(registerRes.status).toBe(200);
    const registerBody = await registerRes.json();
    expect(registerBody.agentId).toBe(freshAgent.id);
    expect(typeof registerBody.secret).toBe("string");

    // 6. Verify fresh agent is active, online, with new secret, decoupled from old agent
    const check2 = (await pool().query(`SELECT status, lifecycle, secret FROM agents WHERE id = $1`, [freshAgent.id])).rows[0];
    expect(check2.status).toBe("online");
    expect(check2.lifecycle).toBe("active");
    expect(check2.secret).toBe(sha256(registerBody.secret));
  });

  it("handles double-delete deterministically", async () => {
    const agentId = "agt_double_delete";
    await pool().query(
      `INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle)
       VALUES ($1, $2, 'Double Agent', $3, 'offline', 'active')`,
      [agentId, TENANT_ID, sha256("sec")],
    );

    // First delete succeeds
    await deleteAgent(agentId);

    // Second delete immediately throws "Agent not found"
    await expect(deleteAgent(agentId)).rejects.toThrow(translate("en", "errors.agentNotFound"));
  });
});
