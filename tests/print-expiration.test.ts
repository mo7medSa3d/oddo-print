import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: print-expiration retired", () => {
  it("removes print-expiration module and print_jobs table", () => {
    expect(existsSync("src/lib/print-expiration.ts")).toBe(false);
    expect(existsSync("src/lib/license-signer.ts")).toBe(true);
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(sql).not.toContain('CREATE TABLE "print_jobs"');
  });
});
