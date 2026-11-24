import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: legacy odoo v2 relay replay retired", () => {
  it("removes odoo-v2-admission, job-maintenance, and print-job-service modules", () => {
    expect(existsSync("src/lib/odoo-v2-admission.ts")).toBe(false);
    expect(existsSync("src/lib/job-maintenance.ts")).toBe(false);
    expect(existsSync("src/lib/print-job-service.ts")).toBe(false);
  });

  it("retires legacy resolutions endpoint with 410 and keeps odoo_installations", () => {
    const route = readFileSync("src/app/api/odoo/installations/resolutions/route.ts", "utf8");
    expect(route).toMatch(/status:\s*410/);
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(sql).toContain('CREATE TABLE "odoo_installations"');
    expect(sql).toContain('CREATE TABLE "odoo_installation_credentials"');
    expect(sql).not.toContain('CREATE TABLE "odoo_v2_operations"');
    expect(sql).not.toContain('CREATE TABLE "odoo_legacy_resolutions"');
  });
});
