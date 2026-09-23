import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Odoo runtime agent picker contract", () => {
  it("forwards assignment_only from the view into the field component", () => {
    const source = readFileSync(
      join(process.cwd(), "odoo_addons/print_gateway/static/src/components/runtime_agent_field.js"),
      "utf8",
    );

    expect(source).toContain("extractProps: ({ options }) => ({");
    expect(source).toContain("assignmentOnly: Boolean(options?.assignment_only)");
    expect(source).toContain("assignment_only: Boolean(props.assignmentOnly)");
    expect(source).toContain('name: "assignment_only"');
  });
});
