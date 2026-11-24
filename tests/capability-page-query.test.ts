import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("License-only control plane: virtual printer SQL retired", () => {
  it("removes printer-virtual-sql and printer-verification-sql modules", () => {
    expect(existsSync("src/lib/printer-virtual-sql.ts")).toBe(false);
    expect(existsSync("src/lib/printer-verification-sql.ts")).toBe(false);
  });

  it("drops printers and discovered_devices from schema and initial migration", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
    for (const dropped of ["printers", "discovered_devices", "discovery_sessions"]) {
      expect(schema).not.toMatch(new RegExp(`pgTable\\("${dropped}"`));
      expect(sql).not.toContain(`CREATE TABLE "${dropped}"`);
    }
  });
});
