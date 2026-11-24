import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyWorkspaceTokenFromCookieValues } from "../src/lib/manager-auth";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("License-Only Gateway dashboard & license authority contract", () => {
  it("removes legacy cloud print-job dashboard server actions", () => {
    expect(existsSync(join(root, "src/app/actions.ts"))).toBe(false);
    expect(typeof verifyWorkspaceTokenFromCookieValues).toBe("function");
  });

  it("gates the dashboard behind live transactional workspace verification without duplicating sidebar links", () => {
    const dashboard = read("src/app/dashboard/page.tsx");
    expect(dashboard).toContain("verifyWorkspaceTokenFromCookieValues");
    expect(dashboard).toContain("requireActiveTenantInTransaction");
    expect(dashboard).toContain("requireManagerActorInTransaction");
    expect(dashboard).toContain('redirect("/login")');
    expect(dashboard).toContain("DirectPrintHeroSvg");
    expect(dashboard).toContain("VisualArchitectureCard");
    expect(dashboard).not.toContain("../actions");
    expect(dashboard).not.toContain("getDashboardState");
    expect(dashboard).not.toContain("getDashboardJobs");
  });

  it("enforces live transactional tenant and subscription authority on license endpoints", () => {
    const refresh = read("src/app/api/license/refresh/route.ts");
    const verify = read("src/app/api/license/verify/route.ts");

    for (const source of [refresh, verify]) {
      expect(source).toContain('"Cache-Control": "no-store"');
      expect(source).toContain("db.transaction(");
      expect(source).toContain('.for("share")');
      expect(source).toContain('tenant.lifecycle !== "active"');
      expect(source).toContain("tenantSubscriptions");
    }
  });
});
