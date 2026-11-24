import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: agent pairing retired", () => {
  it("removes agent-auth module and agents table while keeping license endpoints", () => {
    expect(existsSync("src/lib/agent-auth.ts")).toBe(false);
    expect(existsSync("src/app/api/license/verify/route.ts")).toBe(true);
    expect(existsSync("src/app/api/license/refresh/route.ts")).toBe(true);
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    expect(sql).not.toContain('CREATE TABLE "agents"');
    expect(sql).not.toContain('CREATE TABLE "tenant_domains"');
  });
});
