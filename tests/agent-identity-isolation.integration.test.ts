import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: legacy agent & delivery isolation retired", () => {
  it("removes legacy agent-auth and job-delivery modules", () => {
    expect(existsSync("src/lib/agent-auth.ts")).toBe(false);
    expect(existsSync("src/lib/job-delivery.ts")).toBe(false);
  });

  it("excludes agents and print_jobs tables while retaining tenant-scoped odoo_installations", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(schema).not.toMatch(/pgTable\("agents"/);
    expect(schema).not.toMatch(/pgTable\("print_jobs"/);
    expect(sql).not.toContain('CREATE TABLE "agents"');
    expect(sql).not.toContain('CREATE TABLE "print_jobs"');
    expect(sql).toContain('CREATE TABLE "odoo_installations"');
    expect(sql).toContain('UNIQUE("tenant_id", "id")');
  });
});
