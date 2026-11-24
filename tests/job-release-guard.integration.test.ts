import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: job-delivery and fencing retired", () => {
  it("removes job-delivery and job-fencing modules and print_jobs table", () => {
    expect(existsSync("src/lib/job-delivery.ts")).toBe(false);
    expect(existsSync("src/lib/job-fencing.ts")).toBe(false);
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(sql).not.toContain('CREATE TABLE "print_jobs"');
    expect(sql).not.toContain("ON print_jobs");
  });
});
