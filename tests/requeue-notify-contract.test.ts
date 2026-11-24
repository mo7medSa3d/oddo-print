import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("drizzle/0000_initial_schema.sql", "utf8");

describe("License-only schema: legacy PostgreSQL print_jobs triggers removed", () => {
  it("contains no print_jobs table or requeue notify trigger", () => {
    expect(migration).not.toContain('CREATE TABLE "print_jobs"');
    expect(migration).not.toContain("ON print_jobs");
    expect(migration).not.toContain("AFTER INSERT OR UPDATE OF status ON print_jobs");
  });
});
