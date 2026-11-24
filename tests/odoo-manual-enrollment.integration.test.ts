import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { POST as manualEnroll } from "../src/app/api/odoo/installations/route";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("manual Odoo installation enrollment agrees with auto-enrollment", () => {
  let tenantId: string;
  let keyId: string;
  let access: string;

  beforeAll(async () => { vi.stubEnv("GATEWAY_JWT_SECRET", "odoo-integration-auth-fixture-secret-32"); await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    const f = await seedFixture({ odooIdempotencyMode: "strict_v2" });
    tenantId = f.tenantId;
    keyId = (await pool().query("SELECT id FROM api_keys WHERE tenant_id=$1", [tenantId])).rows[0].id;
    access = (await createWorkspaceManagerTestSession(tenantId, { role: "owner" })).token;
  });
  afterAll(async () => { await closePool(); vi.unstubAllEnvs(); });

  const register = (name: string) => manualEnroll(new Request("https://gateway.test/api/odoo/installations", {
    method: "POST",
    headers: { authorization: "Bearer " + access, "content-type": "application/json" },
    body: JSON.stringify({ name, apiKeyId: keyId }),
  }));

  it("permits two verified installations with one live API key as migration 0087 specifies", async () => {
    const first = await register("Sales database");
    const second = await register("Warehouse database");
    expect([first.status, second.status]).toEqual([201, 201]);
    const a = await first.json();
    const b = await second.json();
    expect(a.installationId).not.toBe(b.installationId);
    expect(a.installationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.installationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.installationProof).not.toBe(b.installationProof);
    const linked = await pool().query(
      "SELECT installation_id FROM odoo_installation_credentials WHERE tenant_id=$1 AND api_key_id=$2 ORDER BY installation_id",
      [tenantId, keyId],
    );
    expect(linked.rows.map(row => row.installation_id).sort()).toEqual([a.installationId, b.installationId].sort());
    const stored = await pool().query("SELECT secret_hash FROM odoo_installations WHERE tenant_id=$1 ORDER BY id", [tenantId]);
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) {
      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.secret_hash).not.toBe(a.installationProof);
      expect(row.secret_hash).not.toBe(b.installationProof);
    }
  });

  it("does not provision an installation while the manual subscription is suspended", async () => {
    await pool().query("UPDATE tenant_subscriptions SET status='suspended' WHERE tenant_id=$1", [tenantId]);
    const response = await register("Blocked installation");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TENANT_SUBSCRIPTION_REQUIRED" });
    const rows = await pool().query("SELECT id FROM odoo_installations WHERE tenant_id=$1", [tenantId]);
    expect(rows.rows).toEqual([]);
  });

  it("preserves the tenant -> credential -> actor -> billing mutation lock order", () => {
    const source = readFileSync("src/app/api/odoo/installations/route.ts", "utf8");
    const tenant = source.indexOf("await requireActiveTenantInTransaction(tx, manager.tenantId);");
    const credential = source.indexOf("const credential = await tx.execute");
    const actor = source.indexOf('await requireManagerActorInTransaction(tx, manager, "integrations.manage");');
    const billing = source.indexOf("await requireTenantBillingAccess(tx, manager.tenantId);");
    expect(tenant).toBeGreaterThanOrEqual(0);
    expect(tenant).toBeLessThan(credential);
    expect(credential).toBeLessThan(actor);
    expect(actor).toBeLessThan(billing);
  });
});
