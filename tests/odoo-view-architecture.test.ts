import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("Odoo 19 view architecture contract — gateway_config_views.xml", () => {
  it("keeps the setup form native to Odoo 19 and free of legacy conditional markup", () => {
    const xml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    const formStart = xml.indexOf('id="view_print_gateway_config_form"');
    const listStart = xml.indexOf('id="view_print_gateway_config_list"');
    const formEnd = xml.indexOf('<record id="view_print_gateway_config_search"', formStart);
    const formSection = xml.slice(formStart, formEnd);
    const listSection = xml.slice(listStart, formStart);

    // Odoo 19 form views use regular view attributes; this module does not
    // inject QWeb conditionals into the configuration form.
    expect(formSection).not.toContain("t-if=");
    expect(formSection).not.toContain("t-att-class");
    expect(formSection).not.toContain("t-attf-class");

    // The setup form exposes only persisted operator-facing configuration.
    expect(formSection).toContain('field name="company_id" string="Company"');
    expect(formSection).toContain('field name="enabled" widget="boolean_toggle" string="Enable Printing Service"');
    expect(formSection).toContain('field name="gateway_url"');
    expect(formSection).toContain('field name="gateway_api_key" password="True"');
    expect(formSection).toContain('field name="last_test_status"');
    expect(formSection).not.toContain('field name="gateway_sync_state"');
    expect(formSection).not.toContain('field name="gateway_sync_message"');
    expect(formSection).toContain("<header/>");

    // The list shows the same operator-level connection state and does not
    // expose the internal reconciliation state machine.
    expect(listSection).toContain('string="Connection"');
    expect(listSection).toContain('name="last_test_status"');
    expect(listSection).not.toContain('name="gateway_sync_state"');
  });

  it("keeps internal recovery controls out of the customer-facing setup form", () => {
    const xml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    const formStart = xml.indexOf('id="view_print_gateway_config_form"');
    const formEnd = xml.indexOf('<record id="view_print_gateway_config_search"', formStart);
    const formSection = xml.slice(formStart, formEnd);

    // Recovery/reconciliation actions remain backend implementation details;
    // the setup form is deliberately limited to connection configuration.
    for (const action of [
      'name="action_retry_enabled_sync"',
      'name="action_reset_stale_sync_state"',
      'name="action_open_pairing_wizard"',
      'name="action_open_runtime_assignments"',
      'name="action_clear_api_key"',
    ]) {
      expect(formSection).not.toContain(action);
    }
  });

  it("keeps the Odoo 19 configuration state readable through connection status", () => {
    const xml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    const listStart = xml.indexOf('id="view_print_gateway_config_list"');
    const formStart = xml.indexOf('id="view_print_gateway_config_form"');
    const listSection = xml.slice(listStart, formStart);

    expect(listSection).toContain('widget="badge"');
    expect(listSection).toContain('decoration-success="last_test_status == \'success\'"');
    expect(listSection).toContain('decoration-danger="last_test_status in (\'failed\', \'revoked\')"');
    expect(listSection).toContain('decoration-muted="last_test_status == \'draft\'"');
  });
});

describe("Odoo 19 module layout contract — full-width pages", () => {
  it("renders module forms at full viewport width with a centered sheet, at any screen size or zoom", () => {
    // Odoo caps .o_form_sheet at a fixed pixel max-width; the module opts its
    // forms out through the .o_pg_view class carried by every print_gateway
    // form view. The pairing wizard is a modal and keeps its compact layout.
    const scss = read("odoo_addons/print_gateway/static/src/scss/print_gateway_backend.scss");
    expect(scss).toContain(".o_pg_view.o_form_view:not(.o_pg_pairing_wizard) .o_form_sheet_bg .o_form_sheet");
    expect(scss).toContain("max-width: 100%");
    // The stylesheet must stay registered as a backend asset or the rule dies.
    const manifest = read("odoo_addons/print_gateway/__manifest__.py");
    expect(manifest).toContain("print_gateway_backend.scss");
  });
});
