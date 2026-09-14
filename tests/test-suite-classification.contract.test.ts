import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { integrationTestFiles, integrationVitestTestFiles } from "../vitest.test-groups";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

function isDatabaseGated(source: string): boolean {
  return /describe\.skipIf\(!hasTestDatabase|describe\.skipIf\(!hasDatabase/.test(source);
}

describe("test suite classification", () => {
  it("uses the dedicated unit config", () => {
    expect(packageJson.scripts["test:unit"]).toBe("vitest run --config vitest.unit.config.mts");
  });

  it("keeps database-gated Vitest suites in the integration group", () => {
    const integrationSet = new Set(integrationVitestTestFiles);
    for (const name of readdirSync("tests")) {
      if (!name.endsWith(".test.ts")) continue;
      const source = readFileSync(join("tests", name), "utf8");
      const file = `tests/${name}` as (typeof integrationVitestTestFiles)[number];
      expect(integrationSet.has(file)).toBe(isDatabaseGated(source));
    }
  });

  it("keeps the integration config as the canonical DB suite", () => {
    expect(packageJson.scripts["test:integration"]).toContain("vitest.integration.config.mts");
    expect(integrationTestFiles.length).toBe(integrationVitestTestFiles.length + 1);
    expect(integrationTestFiles).toContain("tests/ci-tripwire.check.ts");
  });
});
