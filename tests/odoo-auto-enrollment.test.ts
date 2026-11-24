import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const file = (path: string) => readFileSync(path, "utf8");

describe("zero-touch Odoo v2 enrollment contracts", () => {
  it("binds automatic enrollment to a live Odoo API key and the tenant", () => {
    const endpoint = file("src/app/api/odoo/installations/auto/route.ts");
    expect(endpoint).toContain("validateOdooKey");
    expect(endpoint).toContain("requireActiveTenantInTransaction");
    expect(endpoint).toContain("requireTenantBillingAccess");
    expect(endpoint).toContain("proofMatches");
    expect(endpoint).toContain("INSTALLATION_OWNERSHIP_CONFLICT");
    expect(endpoint).not.toContain("installationProof: installationProof");
  });

  it("preserves the old operator-only API and immutable receipt history", () => {
    const old = file("src/app/api/odoo/installations/route.ts");
    expect(old).toContain("validateWorkspaceManager");
    expect(old).toContain("requireManagerPermission");
    const migration = file("drizzle/0000_initial_schema.sql");
    expect(migration).not.toMatch(/UPDATE\s+"?print_jobs"?/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });

  it("keeps one platform API-key row while representing all installed Odoo databases", () => {
    const inventory = file("src/app/api/platform/integrations/route.ts");
    const page = file("src/app/platform/integrations/page.tsx");
    expect(inventory).toContain("installationCount: sql<number>");
    expect(inventory).not.toContain(".leftJoin(odooInstallationCredentials,");
    expect(page).toContain("row.installationCount > 1");
  });
});
