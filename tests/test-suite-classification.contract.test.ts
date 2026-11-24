import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { integrationTestFiles, integrationVitestTestFiles, retiredPrintingRuntimeSuites } from "../vitest.test-groups.mts";

const retired = new Set<string>(retiredPrintingRuntimeSuites);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

function requiresIntegrationPhase(source: string): boolean {
  return /describe\.skipIf\(!(?:hasTestDatabase|hasDatabase|hasProductionBuild)/.test(source);
}

describe("test suite classification", () => {
  it("does not silently classify missing or duplicate integration suites", () => {
    expect(new Set(integrationTestFiles).size).toBe(integrationTestFiles.length);
    for (const file of integrationTestFiles) {
      expect(statSync(file, { throwIfNoEntry: false })?.isFile(), file).toBe(true);
    }
  });

  it("registers every integration-named suite for the PostgreSQL phase", () => {
    // An unregistered database regression can silently skip in the unit
    // suite (DATABASE_URL absent) and never run in the integration suite.
    const registered = new Set<string>(integrationVitestTestFiles);
    const missing = readdirSync("tests")
      .filter((name) => name.endsWith(".integration.test.ts"))
      .map((name) => `tests/${name}`)
      .filter((name) => !registered.has(name) && !retired.has(name))
      .sort();
    expect(missing).toEqual([]);
  });

  it("uses the dedicated unit config", () => {
    expect(packageJson.scripts["test:unit"]).toBe("vitest run --config vitest.unit.config.mts");
  });

  it("keeps database- and build-gated Vitest suites in the integration group", () => {
    const integrationSet = new Set(integrationVitestTestFiles);
    for (const name of readdirSync("tests")) {
      if (!name.endsWith(".test.ts") || retired.has(`tests/${name}`)) continue;
      const source = readFileSync(join("tests", name), "utf8");
      // The integration group also hosts self-contained license-only control
      // plane contract suites (no DB gate) kept there after printing retired.
      // Require every DB/build-gated suite to be in the group; the group may
      // legitimately be a superset of those suites.
      if (!requiresIntegrationPhase(source)) continue;
      const file = `tests/${name}` as (typeof integrationVitestTestFiles)[number];
      expect(integrationSet.has(file), file).toBe(true);
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
    expect(integrationTestFiles.length).toBe(integrationVitestTestFiles.length);
    for (const file of retired) {
      expect(integrationTestFiles).not.toContain(file);
    }
  });
});
