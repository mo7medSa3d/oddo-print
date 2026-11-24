import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: job-history retired", () => {
  it("removes job-history module and legacy job history tables", () => {
    expect(existsSync("src/lib/job-history.ts")).toBe(false);
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    for (const dropped of ["print_jobs", "print_job_receipts", "job_events"]) {
      expect(schema).not.toMatch(new RegExp(`pgTable\\("${dropped}"`));
      expect(sql).not.toContain(`CREATE TABLE "${dropped}"`);
    }
    expect(sql).toContain('CREATE TABLE "audit_events"');
  });
});
