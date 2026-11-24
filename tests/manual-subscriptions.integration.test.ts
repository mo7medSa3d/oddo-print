import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: manual subscriptions schema", () => {
  it("removes legacy manual-usage-report and print-job-service modules", () => {
    expect(existsSync("src/lib/manual-usage-report.ts")).toBe(false);
    expect(existsSync("src/lib/print-job-service.ts")).toBe(false);
  });

  it("retains billing tables and drops print_monthly_usage", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    for (const kept of ["plans", "tenant_subscriptions", "subscription_changes", "subscription_requests"]) {
      expect(schema).toMatch(new RegExp(`pgTable\\("${kept}"`));
      expect(sql).toContain(`CREATE TABLE "${kept}"`);
    }
    expect(schema).not.toMatch(/pgTable\("print_monthly_usage"/);
    expect(sql).not.toContain('CREATE TABLE "print_monthly_usage"');
  });
});
