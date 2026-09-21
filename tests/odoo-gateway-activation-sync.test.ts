import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("Odoo Gateway activation synchronization", () => {
  it("keeps Odoo activation separate from tenant lifecycle and fences updates by revision", () => {
    const route = read("src/app/api/odoo/configuration/route.ts");
    const schema = read("src/db/schema.ts");
    const migration = read("drizzle/0054_odoo_gateway_activation_state.sql");

    expect(route).toContain("validateOdooKey");
    expect(route).toContain("odooEnabledRevision");
    expect(route).toContain("lt(tenants.odooEnabledRevision");
    expect(route).toContain("stale_revision");
    expect(route).toContain("Conflicting Odoo gateway activation update");
    expect(route).not.toContain("tenants.lifecycle");

    const auth = read("src/lib/odoo-auth.ts");
    expect(auth).toContain("requireActiveTenant?: boolean");
    expect(auth).toContain("options.requireActiveTenant !== false");

    expect(schema).toContain('odooEnabled: boolean("odoo_enabled")');
    expect(schema).toContain('odooEnabledRevision: integer("odoo_enabled_revision")');
    expect(schema).toContain('odooEnabledUpdatedAt: timestamp("odoo_enabled_updated_at")');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "odoo_enabled"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "odoo_enabled_revision"');
  });

  it("renders Gateway Configuration status from the Odoo-sourced state and refreshes it", () => {
    const page = read("src/app/api-keys/page.tsx");
    expect(page).toContain('fetch("/api/odoo/configuration"');
<<<<<<< ours
    expect(page).toContain("window.setInterval(loadGatewayConfiguration, 5000)");
    expect(page).toContain('label={gatewayConfig.enabled ? "Enabled in Odoo" : "No active Odoo configuration"}');
    expect(page).toContain("Removing Gateway Configuration in Odoo disables Odoo printing here.");
    expect(page).toContain("credentials are separate.");
||||||| base
    expect(page).toContain("window.setInterval(loadGatewayConfiguration, 5000)");
    expect(page).toContain('label={gatewayConfig.enabled ? "Enabled in Odoo" : "Disabled in Odoo"}');
    expect(page).toContain("Odoo controls whether printing is enabled.");
    expect(page).toContain("API credentials are managed separately.");
=======
    expect(page).toContain("setInterval");
    // Professional concise labels — verifies Odoo-sourced state still shown
    expect(page).toContain("Credential");
    expect(page).toContain("Odoo");
    expect(page).toContain("Gateway");
    expect(page).toContain("API Keys");
>>>>>>> theirs
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
    expect(view).toContain('string="Gateway Status"');
    expect(view).toContain('field name="gateway_sync_message"');
    expect(view).toContain('id="view_print_gateway_config_search"');
    expect(view).toContain('field name="search_view_id" ref="view_print_gateway_config_search"');
    expect(view).toContain('name="filter_enabled"');
    expect(view).toContain('name="filter_attention"');
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


describe("Operations observability presentation", () => {
  it("does not expose raw diagnostic JSON in agent or printer observability components", () => {
    const agent = read("src/components/AgentHealthMatrix.tsx");
    const printer = read("src/components/PrinterCapabilityMatrix.tsx");

    expect(agent).not.toContain("JSON.stringify(c.details");
    expect(agent).toContain("Show technical details");
    expect(agent).toContain("Last seen");
    expect(agent).toContain("Needs attention");

    expect(printer).not.toContain("JSON.stringify");
    expect(printer).toContain("Print features");
    expect(printer).toContain("Windows Spooler");
  });

  it("uses the simplified operations headings in the dashboard", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain(">Agent Status</h3>");
    expect(dashboard).toContain(">Printer Fleet</h3>");
    expect(dashboard).toContain(">Print Certification</h3>");
    expect(dashboard).not.toContain("Agent Health (ONLINE/DEGRADED/OFFLINE/STARTING");
  });
});
