import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("Odoo Gateway status UI contract", () => {
  it("keeps integration state separate from API credential state", () => {
    const source = read("src/app/api-keys/page.tsx");
    expect(source).toContain("Enabled in Odoo");
    expect(source).toContain("Disabled in Odoo");
    expect(source).toContain("Valid credential");
    expect(source).toContain("Revoked credential");
    expect(source).toContain("Odoo controls whether printing is enabled.");
    expect(source).not.toContain('label={gatewayConfig.enabled ? "Active" : "Inactive"}');
  });

  it("uses the shared accessible confirmation modal instead of browser-native confirms", () => {
    const source = read("src/app/api-keys/page.tsx");
    expect(source).toContain("Modal");
    expect(source).toContain("Revoke API key?");
    expect(source).toContain("Remove revoked API key?");
    expect(source).not.toContain("window.confirm");
  });
});
