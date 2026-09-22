import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool, type Fixture } from "./helpers/pg";
import { PATCH as configurationPATCH } from "../src/app/api/odoo/configuration/route";
import { GET as healthGET } from "../src/app/api/odoo/health/route";
import { POST as printJobsPOST } from "../src/app/api/print/jobs/route";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("Odoo Gateway activation synchronization", () => {
  it("keeps Odoo activation separate from tenant lifecycle and fences updates by revision", () => {
    const route = read("src/app/api/odoo/configuration/route.ts");
    const schema = read("src/db/schema.ts");
    const migration = read("drizzle/0058_scope_odoo_activation_to_api_key.sql");

    expect(route).toContain("validateOdooKey");
    expect(route).toContain("ODOO_KEY_READ_ONLY");
    expect(route).toContain('scope ?? "standard"');
    expect(route).toContain("odooEnabledRevision");
    expect(route).toContain("lt(apiKeys.odooEnabledRevision");
    expect(route).toContain("stale_revision");
    expect(route).toContain("Conflicting Odoo gateway activation update");
    expect(route).not.toContain("tenants.lifecycle");

    const auth = read("src/lib/odoo-auth.ts");
    expect(auth).toContain("requireActiveTenant?: boolean");
    expect(auth).toContain("options.requireActiveTenant !== false");

    expect(schema).toContain('odooEnabled: boolean("odoo_enabled")');
    expect(schema).toContain('odooEnabledRevision: integer("odoo_enabled_revision")');
    expect(schema).toContain('odooEnabledUpdatedAt: timestamp("odoo_enabled_updated_at")');
    expect(schema).toContain("apiKeys");
    expect(schema).toContain("api_keys_odoo_enabled_revision_check");
    expect(route).not.toContain("tenants.odooEnabled");
    expect(auth).not.toContain("tenants.odooEnabled");

    expect(migration).toContain('ALTER TABLE "api_keys"');
    expect(migration).toContain('UPDATE "api_keys" AS k');
    expect(migration).toContain('Every existing key in a tenant inherits the former tenant-wide activation');
    expect(migration).toContain('DROP COLUMN IF EXISTS "odoo_enabled"');
  });

  describe.skipIf(!hasTestDatabase)("runtime isolation", () => {
    let f: Fixture;
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

    beforeAll(async () => { await applyMigrations(); });
    beforeEach(async () => { await truncateAll(); f = await seedFixture(); });
    afterAll(async () => { await closePool(); });

    it("blocks read-only Odoo keys from changing Gateway activation", async () => {
      const readOnlyKey = "odoo_readonly_activation";
      await pool().query(
        `INSERT INTO api_keys (id, tenant_id, scope, name, hashed_key, odoo_enabled, odoo_enabled_revision)
         VALUES ($1, $2, 'read_only', 'Read only activation', $3, false, 0)`,
        ["key_readonly_activation", f.tenantId, sha256(readOnlyKey)],
      );

      const response = await configurationPATCH(new Request("http://gateway.test/api/odoo/configuration", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${readOnlyKey}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, revision: 1 }),
      }));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "ODOO_KEY_READ_ONLY" });

      const row = await pool().query(
        `SELECT odoo_enabled, odoo_enabled_revision FROM api_keys WHERE id = $1`,
        ["key_readonly_activation"],
      );
      expect(row.rows[0]).toEqual({ odoo_enabled: false, odoo_enabled_revision: 0 });
    });

    it("changes one integration without changing another integration in the same tenant", async () => {
      const keyB = "odoo_company_b_activation";
      await pool().query(
        `INSERT INTO api_keys (id, tenant_id, scope, name, hashed_key, odoo_enabled, odoo_enabled_revision)
         VALUES ($1, $2, 'standard', 'Company B', $3, true, 0)`,
        ["key_company_b", f.tenantId, sha256(keyB)],
      );

      const disableA = await configurationPATCH(new Request("http://gateway.test/api/odoo/configuration", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, revision: 1 }),
      }));
      expect(disableA.status).toBe(200);

      const healthA = await healthGET(new Request("http://gateway.test/api/odoo/health", {
        headers: { Authorization: `Bearer ${f.odooKey}` },
      }));
      const healthB = await healthGET(new Request("http://gateway.test/api/odoo/health", {
        headers: { Authorization: `Bearer ${keyB}` },
      }));
      expect((await healthA.json()).enabled).toBe(false);
      expect((await healthB.json()).enabled).toBe(true);

      const printBody = {
        printerId: f.printerId,
        documentType: "receipt",
        destination: "POS",
        payload: { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" },
      };
      const printA = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...printBody, idempotencyKey: "company-a-disabled" }),
      }));
      const printB = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyB}`, "content-type": "application/json" },
        body: JSON.stringify({ ...printBody, idempotencyKey: "company-b-still-enabled" }),
      }));
      expect(printA.status).toBe(401);
      expect(printB.status).toBe(201);
    });
  });

  it("renders Gateway Configuration status from the Odoo-sourced state and refreshes it", () => {
    const page = read("src/app/api-keys/page.tsx");
    expect(page).toContain('fetch("/api/odoo/keys"');
    expect(page).toContain("setInterval");
    // Professional concise labels — verifies Odoo-sourced state still shown
    expect(page).toContain("Odoo integration");
    expect(page).toContain("Odoo");
    expect(page).toContain("Gateway");
    expect(page).toContain("Connect Odoo");
    expect(page).toContain("odooEnabledRevision");
    expect(page).toContain("Odoo access:");
    expect(page).not.toContain("const id = setInterval(tick, 5000);\n    return () => { cancel = true; clearInterval(id); };\n  }, []);\n\n  useEffect(() => {\n    // Guard r.ok");
  });

  it("fences stale sync outcomes so an older worker cannot create Action needed", () => {
    const model = read("odoo_addons/print_gateway/models/gateway_config.py");
    const client = read("odoo_addons/print_gateway/static/src/js/gateway_config_auto_sync.js");

    expect(model).toContain("expected_revision=None");
    expect(model).toContain("SELECT enabled_sync_revision FROM %s WHERE id = %%s FOR UPDATE");
    expect(model).toContain("int(row[0] or 0) != guard_revision");
    expect(model).toContain('"pending_sync_revision": next_revision');
    expect(model).toContain('"pending_sync_started_at": fields.Datetime.now()');
    expect(model).toContain('expected_revision=revision');
    expect(model).toContain('def _write_test_result_if_current');
    expect(model).toContain('int(row[0] or 0) != int(expected_revision)');
    expect(model).toContain('expected_revision = int(self.enabled_sync_revision or 0)');

    // The save hook must not hand a server "reload" action back to the global
    // action manager: doing so can race the record-level refresh. It must reload
    // the persisted record locally after synchronization completes.
    expect(client).toContain('if (action?.tag === "display_notification")');
    expect(client).toContain("await this.model.load({ resId });");
  });

  it("pushes the Odoo checkbox after commit and retries failed replication", () => {
    const model = read("odoo_addons/print_gateway/models/gateway_config.py");
    const cron = read("odoo_addons/print_gateway/data/cron.xml");
    const view = read("odoo_addons/print_gateway/views/gateway_config_views.xml");

    expect(model).toContain("enabled_sync_revision");
    expect(model).toContain("last_enabled_sync_revision");
    expect(model).toContain("/api/odoo/configuration");
    expect(model).toContain("self.env.cr.postcommit.add");
    expect(model).toContain("pre_sync_credentials");
    expect(model).toContain("record._gateway_api_key_plaintext()");
    expect(model).toContain("self._queue_enabled_state_sync(pre_sync_credentials)");
    expect(model).toContain("self.env.registry.cursor()");
    expect(model).toContain("api.SUPERUSER_ID");
    expect(model).toContain("skip_enabled_sync");
    expect(model).toContain("def cron_sync_enabled_state");
    expect(model).toContain("config._sync_enabled_state_to_gateway(");
    expect(model).toContain("config._gateway_api_key_plaintext()");
    expect(model).toContain("last_enabled_sync_error");

    expect(cron).toContain('id="cron_sync_gateway_enabled_state"');
    expect(cron).toContain("model.cron_sync_enabled_state()");
    expect(view).toContain('string="Connection"');
    expect(view).toContain('field name="last_test_status"');
    expect(view).toContain('id="view_print_gateway_config_search"');
    expect(view).toContain('field name="search_view_id" ref="view_print_gateway_config_search"');
    expect(view).toContain('name="filter_enabled"');
    expect(view).not.toContain('name="filter_attention"');
    expect(view).not.toContain('name="last_enabled_sync_revision"');
    expect(view).not.toContain('name="last_enabled_sync_error"');

    expect(model).toContain("def _disable_gateway_for_unlink");
    expect(model).toContain('json={"enabled": False, "revision": target_revision}');
    expect(model).toContain("record._disable_gateway_for_unlink(");
    expect(model).toContain("pending_disable_gateway_api_key");
    expect(model).toContain("store=True");
    expect(model).toContain("index=True");
  });
});

describe("Odoo Gateway auto-sync client record identity", () => {
  it("uses the persisted resId and never the OWL datapoint id for post-save RPC/load", () => {
    const source = read("odoo_addons/print_gateway/static/src/js/gateway_config_auto_sync.js");
    expect(source).toContain("const resId = record.resId;");
    expect(source).toContain("[[resId]]");
    expect(source).toContain("method,");
    expect(source).toContain("await this.model.load({ resId });");
    expect(source).not.toContain("record.id");
    expect(source).not.toContain("[[record.id]]");
  });
});

describe("Operations observability presentation", () => {
  it("does not expose raw diagnostic JSON in agent or printer observability components", () => {
    const agent = read("src/components/AgentHealthMatrix.tsx");
    const printer = read("src/components/PrinterCapabilityMatrix.tsx");

    expect(agent).not.toContain("JSON.stringify(c.details");
    expect(agent).not.toContain("Show technical details");
    expect(agent).toContain("Gateway");
    expect(agent).toContain("Queue");
    expect(agent).toContain("Printers");
    expect(agent).toContain("Version");

    expect(printer).not.toContain("JSON.stringify");
    expect(printer).toContain("Print features");
    expect(printer).toContain("Windows Spooler");
  });

  it("uses the simplified operations headings in the dashboard", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain(">Agents</h3>");
    expect(dashboard).toContain(">Printers</h3>");
    expect(dashboard).toContain(">Certification</h3>");
    expect(dashboard).not.toContain("Agent Health (ONLINE/DEGRADED/OFFLINE/STARTING");
  });
});
