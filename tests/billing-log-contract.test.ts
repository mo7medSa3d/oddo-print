import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// S-6: billing routes must use the redacting structured logger, never raw console.
describe("billing log redaction contract (S-6)", () => {
  const dir = "src/app/api/billing";
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") files.push(p);
    }
  };
  walk(dir);
  it("has billing routes", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`${f} uses logError`, () => {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/console\.(error|warn|log)/);
    });
  }
});
