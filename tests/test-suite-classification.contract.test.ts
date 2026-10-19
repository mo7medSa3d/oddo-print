import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { integrationTestFiles, integrationVitestTestFiles } from "../vitest.test-groups.mts";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

function requiresIntegrationPhase(source: string): boolean {
  return /describe\.skipIf\(!(?:hasTestDatabase|hasDatabase|hasProductionBuild)/.test(source);
}

describe("test suite classification", () => {
  it("uses the dedicated unit config", () => {
    expect(packageJson.scripts["test:unit"]).toBe("vitest run --config vitest.unit.config.mts");
  });

  it("keeps database- and build-gated Vitest suites in the integration group", () => {
    const integrationSet = new Set(integrationVitestTestFiles);
    for (const name of readdirSync("tests")) {
      if (!name.endsWith(".test.ts")) continue;
      const source = readFileSync(join("tests", name), "utf8");
      const file = `tests/${name}` as (typeof integrationVitestTestFiles)[number];
      expect(integrationSet.has(file)).toBe(requiresIntegrationPhase(source));
    }
  });

  it("runs real HTTP acceptance only after build/migrations and enables its database checks", () => {
    expect(integrationVitestTestFiles).toContain("tests/server-http-acceptance.test.ts");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci.indexOf("run: npm run build")).toBeLessThan(ci.indexOf("run: npm run test:integration"));
    expect(ci.indexOf("run: npm run db:migrate")).toBeLessThan(ci.indexOf("run: npm run test:integration"));
    const config = readFileSync("vitest.integration.config.mts", "utf8");
    expect(config).toContain('RUN_DB_BACKED_ACCEPTANCE: "1"');
  });

  it("keeps the integration config as the canonical DB suite", () => {
    expect(packageJson.scripts["test:integration"]).toContain("vitest.integration.config.mts");
    expect(integrationTestFiles.length).toBe(integrationVitestTestFiles.length + 1);
    expect(integrationTestFiles).toContain("tests/ci-tripwire.check.ts");
  });
});
