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

    expect(schema).toContain('odooEnabled: boolean("odoo_enabled")');
    expect(schema).toContain('odooEnabledRevision: integer("odoo_enabled_revision")');
    expect(schema).toContain('odooEnabledUpdatedAt: timestamp("odoo_enabled_updated_at")');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "odoo_enabled"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "odoo_enabled_revision"');
  });

  it("renders Gateway Configuration status from the Odoo-sourced state and refreshes it", () => {
    const page = read("src/app/api-keys/page.tsx");
    expect(page).toContain('fetch("/api/odoo/configuration"');
    expect(page).toContain("window.setInterval(loadGatewayConfiguration, 5000)");
    expect(page).toContain('label={gatewayConfig.enabled ? "Active" : "Inactive"}');
    expect(page).toContain("Odoo is the source of truth.");
  });

  it("pushes the Odoo checkbox after commit and retries failed replication", () => {
    const model = read("odoo_addons/print_gateway/models/gateway_config.py");
    const cron = read("odoo_addons/print_gateway/data/cron.xml");
    const view = read("odoo_addons/print_gateway/views/gateway_config_views.xml");

    expect(model).toContain("enabled_sync_revision");
    expect(model).toContain("last_enabled_sync_revision");
    expect(model).toContain('"/api/odoo/configuration"');
    expect(model).toContain("self.env.cr.postcommit.add");
    expect(model).toContain("self.env.registry.cursor()");
    expect(model).toContain("api.SUPERUSER_ID");
    expect(model).toContain("skip_enabled_sync");
    expect(model).toContain("def cron_sync_enabled_state");
    expect(model).toContain("config._sync_enabled_state_to_gateway(");
    expect(model).toContain("config._gateway_api_key_plaintext()");
    expect(model).toContain("last_enabled_sync_error");

    expect(cron).toContain('id="cron_sync_gateway_enabled_state"');
    expect(cron).toContain("model.cron_sync_enabled_state()");
    expect(view).toContain('string="Gateway Activation Sync"');
    expect(view).toContain('name="last_enabled_sync_revision"');
  });
});
