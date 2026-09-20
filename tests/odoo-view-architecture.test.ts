import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("Odoo 19 view architecture contract — gateway_config_views.xml", () => {
  it("uses invisible (Python expression) for conditional rendering, not QWeb t-if/t-att in form view", () => {
    const xml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    // Extract form view section
    const formStart = xml.indexOf('id="view_print_gateway_config_form"');
    const formSection = xml.slice(formStart, formStart + 8000);

    // Must NOT use QWeb directives t-if, t-att-class, t-attf-class inside form view
    // per Odoo 19 official docs: form views use invisible attribute, not QWeb
    // https://www.odoo.com/documentation/19.0/developer/reference/user_interface/view_architectures.html
    expect(formSection).not.toContain("t-if=");
    expect(formSection).not.toContain("t-att-class");
    expect(formSection).not.toContain("t-attf-class");

    // Must use invisible with Python expressions for state row
    expect(formSection).toContain('invisible="not gateway_api_key"');
    expect(formSection).toContain('invisible="gateway_api_key"');
    expect(formSection).toContain('invisible="not enabled"');
    expect(formSection).toContain('invisible="enabled"');
    expect(formSection).toContain('invisible="gateway_sync_state != \'active\'"');
    expect(formSection).toContain('invisible="gateway_sync_state != \'syncing\'"');
    expect(formSection).toContain('invisible="gateway_sync_state != \'attention\'"');
    expect(formSection).toContain("invisible=\"gateway_sync_state not in ('disabled','not_configured')\"");

    // Must preserve distinct state row with credential/activation/connection
    expect(formSection).toContain("o_pg_cred_card");
    expect(formSection).toContain("o_pg_connection_banner");
    expect(formSection).toContain("is-active");
    expect(formSection).toContain("is-syncing");
    expect(formSection).toContain("is-attention");
    expect(formSection).toContain("is-disabled");
  });

  it("preserves Gateway Status string in list view for contract", () => {
    const xml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    const listStart = xml.indexOf('id="view_print_gateway_config_list"');
    const listSection = xml.slice(listStart, listStart + 2000);
    expect(listSection).toContain('string="Gateway Status"');
    expect(listSection).toContain('name="gateway_sync_state"');
  });

  it("documents Odoo 19 official source for view architecture", () => {
    // This test ensures the fix is documented with official reference
    // https://www.odoo.com/documentation/19.0/developer/reference/user_interface/view_architectures.html
    // Form views are composed of regular HTML with semantic components, invisible attribute uses Python expression
    const xml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    expect(xml).toContain("Distinct State Row");
    expect(xml).toContain("Odoo 19 form view uses invisible");
  });
});
