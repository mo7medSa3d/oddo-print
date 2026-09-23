import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production TypeScript safety contracts", () => {
  it("does not use escape-hatch casts or suppression directives in source", () => {
    const root = resolve(process.cwd(), "src");
    const files = [
      "app/api/printers/[id]/route.ts",
      "desktop/components/AddPrinterDialog.tsx",
      "db/schema.ts",
    ];

    for (const relative of files) {
      const source = readFileSync(resolve(root, relative), "utf8");
      expect(source).not.toMatch(/\bas\s+(?:any|never)\b/);
      expect(source).not.toMatch(/@ts-(?:ignore|expect-error)/);
    }
  });

  it("keeps printer capability metadata compatible with the API's validated record contract", () => {
    const source = readFileSync(resolve(process.cwd(), "src/db/schema.ts"), "utf8");
    expect(source).toContain('capabilities: jsonb("capabilities").$type<Record<string, unknown>>()');
  });
  it("awaits the database-backed manager token verifier on server pages", () => {
    const pages = [
      "app/billing/page.tsx",
      "app/dashboard/page.tsx",
      "app/page.tsx",
      "app/pricing/page.tsx",
      "app/release-readiness/page.tsx",
      "app/system-health/page.tsx",
    ];
    for (const relative of pages) {
      const source = readFileSync(resolve(process.cwd(), "src", relative), "utf8");
      expect(source).toContain("token ? await verifyManagerToken(token) : null");
      expect(source).not.toContain("validateManagerClaims(token ? verifyManagerToken(token) : null)");
    }
  });

  it("keeps database-clock printer updates compatible with Drizzle update typing", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/api/printers/[id]/route.ts"), "utf8");
    expect(source).toContain("updatedAt: SQL;");
    expect(source).toContain("updatedAt: sql`now()`");
    expect(source).not.toContain("Partial<typeof printers.$inferInsert> = { updatedAt: sql`now()` }");
  });
});
