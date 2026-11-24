import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: database clock defaults", () => {
  it("retires print-job-service and keeps clock_timestamp() defaults on control-plane tables", () => {
    expect(existsSync("src/lib/print-job-service.ts")).toBe(false);
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain('CREATE TABLE "odoo_installations"');
    expect(sql).not.toContain('CREATE TABLE "print_jobs"');
  });
});
