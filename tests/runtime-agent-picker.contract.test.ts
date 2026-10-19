import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Odoo runtime agent picker contract", () => {
  it("forwards assignment_only from the view into the field component", () => {
    const source = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/static/src/components/runtime_agent_field.js"),
      "utf8",
    );
    const bindingView = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/views/binding_views.xml"),
      "utf8",
    );
    const assignmentView = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/views/runtime_assignment_views.xml"),
      "utf8",
    );

    expect(source).toContain("extractProps: ({ options }) => ({");
    expect(source).toContain("assignmentOnly: Boolean(options?.assignment_only)");
    expect(source).toContain("assignment_only: Boolean(props.assignmentOnly)");
    expect(source).toContain('name: "assignment_only"');
    expect(source).toContain("const runtimeAgentBindingField = {");
    expect(source).toContain("extractProps: () => ({");
    expect(source).toContain("assignmentOnly: true,");
    expect(source).toContain('"gateway_runtime_agent_binding"');
    expect(source.match(/force: true/g)?.length).toBe(3);
    expect(bindingView).toContain('widget="gateway_runtime_agent_binding"');
    expect(bindingView).not.toContain("assignment_only");
    expect(assignmentView).toContain('widget="gateway_runtime_agent"');
    expect(assignmentView).not.toContain('widget="gateway_runtime_agent_binding"');
  });

  it("re-queries the runtime scope through reactive dependencies instead of props identity", () => {
    // OWL only runs onWillUpdateProps when a *prop* differs (shallow compare,
    // see arePropsDifferent in ComponentNode.updateProps). Company/Branch/Agent
    // live on the record the widget already holds, so a props-driven reload
    // never fires when the operator selects a Branch: the widget kept the
    // company-only list (which is empty when the Agent is assigned to the
    // Branch) and the assigned Agent never showed up in the Print Rule form.
    // The scope must therefore be read as a reactive dependency of an effect,
    // which subscribes the widget to those record fields.
    const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
    const agentSource = source("odoo_addons/print_gateway/static/src/components/runtime_agent_field.js");
    expect(agentSource).not.toMatch(/onWillUpdateProps\s*\(/);
    expect(agentSource).toContain("() => [this.companyId, this.branchId, this.assignmentOnly],");
    expect(agentSource).toContain("get branchId() {");
    expect(agentSource).toContain("return relationalId(this.props.record?.data?.branch_id);");
    expect(agentSource).toContain("branch_id: branchId,");
    expect(agentSource).toContain("fieldDependencies: [");

    const printerSource = source("odoo_addons/print_gateway/static/src/components/runtime_printer_field.js");
    expect(printerSource).not.toMatch(/onWillUpdateProps\s*\(/);
    expect(printerSource).toContain("() => [this.companyId, this.branchId, this.agentId, this.destinationType, this.reportId, this.documentType],");
    expect(printerSource).toContain("agent_id: agentId,");
  });

  it("keeps the Odoo module icon byte-identical to the desktop app icon", () => {
    const odooIcon = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/static/description/icon.png"),
    );
    const desktopIcon = readFileSync(
      join(process.cwd(), "src-tauri/icons/icon.png"),
    );

    expect(odooIcon.equals(desktopIcon)).toBe(true);
  });


  it("renders the readonly Agent without assigning to its getter-only component property", () => {
    // Owl t-set writes to the template context. If a local binding shares
    // a name with the component's getter-only selectedAgent accessor,
    // readonly views crash during the Owl render lifecycle.
    const source = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/static/src/components/runtime_agent_field.js"),
      "utf8",
    );
    const readonlyBranch = source.split('<t t-if="props.readonly">')[1]?.split('<t t-else="">')[0];
    expect(readonlyBranch).toBeTruthy();
    expect(source).toContain("get selectedAgent() {");
    expect(readonlyBranch).toContain('<t t-set="displayAgent" t-value="this.selectedAgent"/>');
    expect(readonlyBranch).toContain('t-esc="displayAgent?.name');
    expect(readonlyBranch).toContain('t-if="displayAgent"');
    expect(readonlyBranch).toContain('t-esc="statusLabel(displayAgent)"');
    const getterNames = [...source.matchAll(/\bget\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/g)].map((match) => match[1]);
    const localBindings = [...source.matchAll(/\bt-set="([A-Za-z_$][\w$]*)"/g)].map((match) => match[1]);
    for (const binding of localBindings) {
      expect(getterNames).not.toContain(binding);
    }
  });

});
