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

  it("keeps the Odoo module icon byte-identical to the desktop app icon", () => {
    const odooIcon = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/static/description/icon.png"),
    );
    const desktopIcon = readFileSync(
      join(process.cwd(), "src-tauri/icons/icon.png"),
    );

    expect(odooIcon.equals(desktopIcon)).toBe(true);
  });

});
