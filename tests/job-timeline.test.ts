import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: job-timeline retired", () => {
  it("removes job-timeline module and job_events table", () => {
    expect(existsSync("src/lib/job-timeline.ts")).toBe(false);
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(schema).not.toMatch(/pgTable\("job_events"/);
    expect(sql).not.toContain('CREATE TABLE "job_events"');
  });
});
