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

  it("reviews dependency install scripts explicitly", () => {
    expect(packageJson.allowScripts).toMatchObject({
      "esbuild@0.28.2": true,
      "unrs-resolver@1.12.2": true,
      "fsevents@2.3.3": true,
    });
  });

  it("pins undici to a patched release in both manifest and lockfile", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    expect(packageJson.overrides?.undici).toBe("8.10.2");
    expect(lock.packages?.["node_modules/undici"]?.version).toBe("8.10.2");
  });

  it("keeps Docker smoke test on an HTTP-only bind without ACME", () => {
    const docker = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
    expect(docker).toContain('GATEWAY_DOMAIN: "http://print.example.com"');
    expect(docker).not.toContain("GATEWAY_DOMAIN: print.example.com");
  });

  it("pins undici to a patched release in both manifest and lockfile", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    expect(packageJson.overrides?.undici).toBe("8.10.2");
    expect(lock.packages?.["node_modules/undici"]?.version).toBe("8.10.2");
  });

  it("keeps Docker smoke test on an HTTP-only bind without ACME", () => {
    const docker = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
    expect(docker).toContain('GATEWAY_DOMAIN: ":80"');
  });

  it("keeps Caddy's forwarded-header security contract warning-free", () => {
    const caddy = readFileSync(path.join(root, "Caddyfile"), "utf8");
    const httpTestCaddy = readFileSync(path.join(root, "deploy/http-test/Caddyfile"), "utf8");
    expect(caddy).not.toContain("header_up X-Forwarded-For");
    expect(httpTestCaddy).not.toContain("header_up X-Forwarded-For");
  });

  it("keeps the Rust desktop JSON contract while using idiomatic field names", () => {
    const commands = readFileSync(path.join(root, "src-tauri/src/commands.rs"), "utf8");
    expect(commands).toContain('#[serde(rename = "isVirtual", alias = "is_virtual")]');
    expect(commands).toContain("pub is_virtual: Option<bool>");
    expect(commands).not.toContain("pub isVirtual: Option<bool>");
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
