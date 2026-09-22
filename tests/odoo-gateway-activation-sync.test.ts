import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool, type Fixture } from "./helpers/pg";
import { PATCH as configurationPATCH } from "../src/app/api/odoo/configuration/route";
import { POST as printJobsPOST } from "../src/app/api/print/jobs/route";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("Odoo Gateway activation synchronization", () => {
  it("keeps Odoo activation separate from tenant lifecycle and fences updates by revision", () => {
    const route = read("src/app/api/odoo/configuration/route.ts");
    const keyRoute = read("src/app/api/odoo/keys/route.ts");
    const rotateRoute = read("src/app/api/odoo/keys/[id]/rotate/route.ts");
    const schema = read("src/db/schema.ts");
    const migration = read("drizzle/0058_scope_odoo_activation_to_api_key.sql");
    const cleanupMigration = read("drizzle/0059_remove_api_key_restrictions.sql");

    expect(route).toContain("validateOdooKey");
    expect(keyRoute).toContain("generateOdooApiKey");
    expect(keyRoute).not.toMatch(/(?:["']scope["']|\bscope\s*:)\s*:/);
    expect(keyRoute).not.toMatch(/(?:["']allowedDocumentTypes["']|\ballowedDocumentTypes\s*:)\s*:/);
    expect(keyRoute).not.toMatch(/(?:["']allowed_document_types["']|\ballowed_document_types\s*:)\s*:/);
    expect(rotateRoute).not.toMatch(/(?:["']scope["']|\bscope\s*:)\s*:/);
    expect(rotateRoute).not.toMatch(/(?:["']allowedDocumentTypes["']|\ballowedDocumentTypes\s*:)\s*:/);
    expect(rotateRoute).not.toMatch(/(?:["']allowed_document_types["']|\ballowed_document_types\s*:)\s*:/);
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
    expect(schema).not.toContain('scope: text("scope")');
    expect(schema).not.toContain('allowed_document_types');

    expect(migration).toContain('ALTER TABLE "api_keys"');
    expect(migration).toContain('UPDATE "api_keys" AS k');
    expect(migration).toContain('Every existing key in a tenant inherits the former tenant-wide activation');
    expect(migration).toContain('DROP COLUMN IF EXISTS "odoo_enabled"');
    expect(cleanupMigration).toContain('DROP COLUMN IF EXISTS "scope"');
    expect(cleanupMigration).toContain('DROP COLUMN IF EXISTS "allowed_document_types"');
  });

  describe.skipIf(!hasTestDatabase)("runtime behavior", () => {
    let f: Fixture;

    beforeAll(async () => { await applyMigrations(); });
    beforeEach(async () => { await truncateAll(); f = await seedFixture(); });
    afterAll(async () => { await closePool(); });

    it("allows the full-access Odoo key to change Gateway activation", async () => {
      const response = await configurationPATCH(new Request("http://gateway.test/api/odoo/configuration", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, revision: 1 }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        applied: true,
        enabled: true,
        revision: 1,
      });
    });

    it("allows the full-access Odoo key to print any document type", async () => {
      const response = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          printerId: f.printerId,
          documentType: "custom-document-type",
          destination: "custom-destination",
          payload: { type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" },
          idempotencyKey: "any-document-type",
        }),
      }));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ documentType: "custom-document-type" });
    });

    it("renders Gateway Configuration status from the Odoo-sourced state and refreshes it", () => {
      const page = read("src/app/api-keys/page.tsx");
      expect(page).toContain('fetch("/api/odoo/keys"');
      expect(page).toContain("setInterval");
      expect(page).toContain("Odoo integration");
      expect(page).toContain("Connect Odoo");
      expect(page).toContain("odooEnabledRevision");
      expect(page).toContain("Read / write · All documents");
      expect(page).not.toContain("Document types");
      expect(page).not.toContain("Read only");
      expect(page).toContain("Odoo access:");
    });
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
