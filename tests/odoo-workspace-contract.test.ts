import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Odoo workspace cross-system contracts", () => {
  it("allows the browser workspace session used by the Odoo integration page to manage API keys", () => {
    const route = read("src/app/api/odoo/keys/route.ts");
    const page = read("src/app/api-keys/page.tsx");

    expect(page).toContain('fetch("/api/odoo/keys"');
    expect(route).toContain("validateWorkspaceManager(req)");
    expect(route).not.toContain("validateManager(req)");
  });

  it("keeps API-key rotation on the same workspace authentication contract", () => {
    const route = read("src/app/api/odoo/keys/[id]/rotate/route.ts");
    expect(route).toContain("validateWorkspaceManager(req)");
    expect(route).not.toContain("validateManager(req)");
  });

  it("keeps Odoo runtime discovery available while the replicated integration flag is disabled", () => {
    const agents = read("src/app/api/odoo/agents/route.ts");
    const printers = read("src/app/api/odoo/printers/route.ts");

    expect(agents).toContain("validateOdooKey(req, { requireIntegrationEnabled: false })");
    expect(printers).toContain("validateOdooKey(req, { requireIntegrationEnabled: false })");
  });
});

it("keeps workspace ownership transfer on the workspace session boundary", () => {
  const route = read("src/app/api/team/ownership/route.ts");
  expect(route).toContain("validateWorkspaceManager(req)");
  expect(route).not.toContain("validateManager(req)");
  expect(route).toContain("clearCustomerSessionCookie()");
  expect(route).toContain("clearCustomerRefreshCookie()");
});
