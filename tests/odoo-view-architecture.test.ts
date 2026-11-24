import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("Odoo 19 view architecture contract — print_service_views.xml", () => {
  it("keeps the setup form native to Odoo 19 and free of legacy conditional markup", () => {
    const xml = read("odoo_addons19/print_gateway/views/print_service_views.xml");
    const formStart = xml.indexOf('id="view_print_gateway_config_form"');
    const listStart = xml.indexOf('id="view_print_gateway_config_list"');
    const formEnd = xml.indexOf('<record id="action_print_gateway_config"', formStart);
    const formSection = xml.slice(formStart, formEnd);
    const listSection = xml.slice(listStart, formStart);

    // Odoo 19 form views use regular view attributes; this module does not
    // inject QWeb conditionals into the configuration form.
    expect(formSection).not.toContain("t-if=");
    expect(formSection).not.toContain("t-att-class");
    expect(formSection).not.toContain("t-attf-class");

    // The setup form exposes direct printing configuration.
    expect(formSection).toContain('field name="company_id"');
    expect(formSection).toContain('field name="enabled" widget="boolean_toggle"');
    expect(formSection).toContain("<header>");

    // The list shows the operator-level state.
    expect(listSection).toContain('field name="company_id"');
    expect(listSection).toContain('field name="enabled" widget="boolean_toggle"');
  });

  it("exposes direct agent and route navigation while keeping actions clean", () => {
    const xml = read("odoo_addons19/print_gateway/views/print_service_views.xml");
    const formStart = xml.indexOf('id="view_print_gateway_config_form"');
    const formEnd = xml.indexOf('<record id="action_print_gateway_config"', formStart);
    const formSection = xml.slice(formStart, formEnd);

    expect(formSection).toContain('name="action_open_pairing_wizard"');
    expect(formSection).toContain('name="action_open_runtime_assignments"');
    expect(formSection).toContain('name="action_open_destinations"');
    expect(formSection).toContain('name="action_open_print_rules"');
  });
});

describe("Odoo 19 module layout contract — full-width pages", () => {
  it("renders module forms at full viewport width with a centered sheet, at any screen size or zoom", () => {
    const scss = read("odoo_addons19/print_gateway/static/src/scss/print_gateway_backend.scss");
    expect(scss).toContain(".o_pg_view.o_form_view:not(.o_pg_pairing_wizard) .o_form_sheet_bg .o_form_sheet");
    expect(scss).toContain("max-width: 100%");
    const manifest = read("odoo_addons19/print_gateway/__manifest__.py");
    expect(manifest).toContain("print_gateway_backend.scss");
  });

  it("opts every native business list and form into addon readability without moving report assets", () => {
    for (const file of [
      "binding_views.xml",
      "print_service_views.xml",
      "print_policy_views.xml",
      "print_job_views.xml",
      "print_intent_views.xml",
      "runtime_assignment_views.xml",
    ]) {
      const xml = read(`odoo_addons19/print_gateway/views/${file}`);
      const views = Array.from(xml.matchAll(/<(form|list)\b[^>]*>/g));
      expect(views.length, file).toBeGreaterThan(0);
    }
    const manifest = read("odoo_addons19/print_gateway/__manifest__.py");
    const posAssets = manifest.slice(manifest.indexOf("'point_of_sale._assets_pos'"), manifest.indexOf("'web.assets_backend'"));
    expect(posAssets).toContain("receipt_raster.css");
    expect(posAssets).not.toContain("print_gateway_tokens.scss");
    expect(posAssets).not.toContain("print_gateway_backend.scss");
  });

  it("keeps pairing dialogs and keyboard errors connected to native controls", () => {
    const scss = read("odoo_addons19/print_gateway/static/src/scss/print_gateway_backend.scss");
    expect(scss).toMatch(/\.o_pg_view\.o_pg_pairing_wizard\s*\{\s*min-height:\s*0/);
    expect(scss).toMatch(/\.o_pg_view,\s*\.o_pg_list,\s*\.o_pg_kanban\s*\{\s*:focus-visible/);
    for (const name of ["agent", "printer"]) {
      const widget = read(`odoo_addons19/print_gateway/static/src/components/runtime_${name}_field.js`);
      expect(widget).toContain('class="o_pg_picker_feedback mt-1 d-flex');
      expect(widget).toContain('t-att-aria-describedby="state.error ? errorId : undefined"');
      expect(widget).toContain('t-att-id="errorId"');
      expect(widget).toContain('type="button" class="btn btn-link btn-sm p-0" t-on-click="retryLoad"');
    }
  });
});

describe("One native print routing workflow, with every operation in the main navigation", () => {
  it("removes the separate inventory page and keeps Agent and printer in the route form", () => {
    const menu = read("odoo_addons19/print_gateway/views/menu.xml");
    const expected = [
      ["menu_print_gateway_config", "Print Service", "10"],
      ["menu_print_gateway_bindings", "Print Routing", "20"],
      ["menu_print_gateway_assignments", "Branch Devices", "30"],
      ["menu_print_gateway_policies", "Automatic Printing", "40"],
      ["menu_print_gateway_jobs", "Print Activity", "50"],
      ["menu_print_gateway_intents", "Automation Activity", "60"],
    ];
    for (const [id, name, sequence] of expected) {
      const row = menu.split("\n").find(line => line.includes(`id="${id}"`)) || "";
      expect(row).toContain(`name="${name}"`);
      expect(row).toContain('parent="menu_print_gateway_main"');
      expect(row).toContain(`sequence="${sequence}"`);
    }
    expect(menu).not.toMatch(/menu_print_gateway_printers|menu_print_gateway_advanced|action_print_gateway_printers|print_gateway\.printers/);
    const addon = "odoo_addons19/print_gateway/";
    const manifest = read(addon + "__manifest__.py");
    expect(manifest).not.toMatch(/printers_overview|printer_scope_labels/);
    const routing = read(addon + "views/binding_views.xml");
    expect(routing).toContain('<form string="Print Route"');
    expect(routing).toContain('widget="gateway_runtime_agent_binding"');
    expect(routing).toContain('widget="gateway_runtime_printer"');
    expect(routing).not.toContain('string="Print test page"');
    expect(read(addon + "views/print_policy_views.xml")).toContain('string="Print Route"');
  });

  it("removes obsolete persisted Odoo actions/menus on upgrade without deleting routes or jobs", () => {
    const migration = read("odoo_addons19/print_gateway/migrations/19.0.2.29.0/post-migrate.py");
    for (const old of ["menu_print_gateway_printers", "menu_print_gateway_advanced", "action_print_gateway_printers"]) {
      expect(migration).toContain(old);
    }
    expect(migration).toContain("children.write({\"parent_id\": root.id})");
    expect(migration).toContain("menu.unlink()");
    expect(migration).toContain("old_action.unlink()");
    expect(migration).not.toContain('env["print_gateway.binding"]');
    expect(migration).not.toContain('env["print_gateway.print_job"]');
  });
});

describe("Odoo UX localization contract", () => {
  it("uses one Arabic label for print routing and exposes both pickers", () => {
    const po = read("odoo_addons19/print_gateway/i18n/ar.po");
    expect(po).toContain('msgid "Print Routing"\nmsgstr "توجيه الطباعة"');
    expect(po).toContain('msgid "Print Route"');
    expect(po).toContain('msgid "Branch Devices"');
    expect(po).toContain('msgid "Automation Activity"');
    const xml = read("odoo_addons19/print_gateway/views/print_service_views.xml");
    expect(xml).toContain('name="action_open_destinations" type="object" string="Print Routing"');
    expect(xml).not.toContain('name="action_open_printers"');
  });
});

describe("Odoo 19 single-company automation view dependencies", () => {
  it("preserves company_id for branch and route domains when multi-company UI is hidden", () => {
    const source = read("odoo_addons19/print_gateway/views/print_policy_views.xml");
    const begin = source.indexOf('<group name="scope_trigger"');
    const end = source.indexOf("</group>", begin);
    const scope = source.slice(begin, end);
    expect(scope).toContain('<field name="company_id" invisible="1"/>');
    expect(scope).toContain('groups="base.group_multi_company"');
    expect(scope).toContain('name="branch_id" domain="[(\'parent_id\', \'=\', company_id)]"');
    expect(source).toContain('name="binding_id" string="Print Route"');
  });
});
