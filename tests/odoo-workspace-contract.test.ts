import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Odoo workspace cross-system contracts", () => {
  it("allows the browser workspace session used by the Odoo integration page to manage API keys", () => {
    const route = read("src/app/api/odoo/keys/route.ts");
    const page = read("src/app/api-keys/page.tsx");

    expect(page).toContain('fetchWithSessionRetry("/api/odoo/keys"');
    expect(page).toContain('credentials: "include"');
    expect(route).toContain("validateWorkspaceManager(req)");
    expect(route).not.toContain("validateManager(req)");
  });

  it("keeps API-key rotation on the same workspace authentication contract", () => {
    const route = read("src/app/api/odoo/keys/[id]/rotate/route.ts");
    expect(route).toContain("validateWorkspaceManager(req)");
    expect(route).not.toContain("validateManager(req)");
  });
});

it("reserves ownership transfer for Platform Owner, revoking both affected workspace families", () => {
  const ordinary = read("src/app/api/team/ownership/route.ts");
  const platform = read("src/app/api/platform/tenants/[id]/ownership/route.ts");
  expect(ordinary).toContain("validateWorkspaceManager(req)");
  expect(ordinary).toContain("PLATFORM_OWNER_REQUIRED");
  expect(ordinary).toContain("status: 401");
  expect(platform).toContain("requirePlatformOwner");
  expect(platform).toContain("requirePlatformActorInTransaction");
  expect(platform).toContain("revokeUserTenantRefreshFamiliesInTransaction");
});
