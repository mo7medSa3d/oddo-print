import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const nodeVersion = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

function workflows(): string[] {
  return globSync(path.join(root, ".github/workflows/*.yml")).map((file) => readFileSync(file, "utf8"));
}

describe("CI/runtime alignment", () => {
  it("uses the declared Node version everywhere Node is provisioned", () => {
    expect(packageJson.engines.node).toBe(">=24.15.0");
    expect(nodeVersion).toBe("24.21.0");
    expect(dockerfile).toContain(`node:${nodeVersion}-alpine`);
    for (const workflow of workflows()) {
      if (/\bnpm (ci|install|run|test|audit)\b|\bnpx\b/.test(workflow)) {
        expect(workflow).toContain("node-version-file: .nvmrc");
      }
    }
  });

  it("derives Go CI from agent/go.mod rather than an unrelated pinned version", () => {
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const go = readFileSync(path.join(root, "agent/go.mod"), "utf8");
    expect(go).toMatch(/^go 1\.26$/m);
    expect(ci).toContain("go-version-file: agent/go.mod");
    expect(ci).not.toMatch(/go-version:\s*['\"]1\.27\.1['\"]/);
  });

  it("resolves the Gateway JWT through the runtime secret loader", () => {
    const source = readFileSync(path.join(root, "src/server/request-guard.ts"), "utf8");
    expect(source).toContain('import { runtimeSecret } from "../lib/runtime-secret";');
    expect(source).toContain('runtimeSecret("GATEWAY_JWT_SECRET")');
    expect(source).not.toContain("process.env.GATEWAY_JWT_SECRET");
  });

  it("keeps third-party Actions SHA-pinned", () => {
    const unpinned = /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@(v\d|stable|main|master|\d+\.)/;
    for (const workflow of workflows()) {
      expect(workflow).not.toMatch(unpinned);
    }
  });

  it("does not reference package scripts that do not exist", () => {
    const scripts = new Set(Object.keys(packageJson.scripts));
    for (const [index, workflow] of workflows().entries()) {
      const workflowName = String(index);
      for (const script of workflow.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
        expect(scripts.has(script[1]), `${workflowName}: missing npm script ${script[1]}`).toBe(true);
      }
    }
  });
});
