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
    expect(nodeVersion).toBe("24.22.1");
    expect(dockerfile).toContain(`node:${nodeVersion}-alpine`);
    for (const workflow of workflows()) {
      const hasHostNodeProvisioning = /uses:\s*actions\/setup-node@[0-9a-f]{40}/.test(workflow);
      if (hasHostNodeProvisioning) {
        // npm on the GitHub runner must use the repository's pinned Node.
        expect(workflow).toContain("node-version-file: .nvmrc");
      } else if (/\bnpm (ci|install|run|test|audit)\b|\bnpx\b/.test(workflow)) {
        // Docker smoke/build executes npm INSIDE a digest-pinned Node base,
        // not on an unconfigured runner. The built image must pin the same
        // declared Node version rather than adding a decorative setup-node.
        expect(workflow).toContain(`node:${nodeVersion}-alpine@sha256:`);
      }
    }
  });

  it("derives Go CI from agent/go.mod rather than an unrelated pinned version", () => {
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const go = readFileSync(path.join(root, "agent/go.mod"), "utf8");
    expect(go).toMatch(/^go 1\.26(?:\.0)?$/m);
    // Go 1.26.11 includes the prior x509 fix plus the November 10, 2026 security fixes.
    expect(go).toMatch(/^toolchain go1\.26\.11$/m);
    for (const filename of [
      "ci.yml",
      "build-windows.yml",
      "security-supply-chain.yml",
      "static-security.yml",
    ]) {
      const workflow = readFileSync(path.join(root, ".github/workflows", filename), "utf8");
      expect(workflow).toContain("go-version-file: agent/go.mod");
    }
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
    expect(packageJson.overrides?.undici).toBe("8.12.2");
    expect(lock.packages?.["node_modules/undici"]?.version).toBe("8.12.2");
  });

  it("keeps PR Docker preflight fast while retaining main full-stack and image gates", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
    const compose = readFileSync(path.join(root, "docker-compose.ci.yml"), "utf8");
    const runtime = workflow.split("\n  docker-build-runtime:")[1];
    const preflight = workflow.split("\n  docker-compose-pr:")[1]?.split("\n  docker-build-runtime:")[0];
    expect(preflight).toBeDefined();
    expect(preflight).toContain("docker compose config --quiet");
    expect(preflight).toContain("github.event_name == 'pull_request'");
    expect(preflight).not.toContain("docker compose build");
    // Main builds the exact released images with pinned build-push actions;
    // PR preflight deliberately does no image build at all.
    expect(preflight).not.toContain("docker/build-push-action@");
    expect(runtime).toContain("github.event_name != 'pull_request'");
    expect(runtime).toContain("docker/build-push-action@");
    // Those images are prebuilt, so Compose starts without rebuilding them.
    expect(runtime).toContain("docker compose up --no-build -d gateway caddy");
    expect(workflow).toContain("Enforce reviewed release image vulnerability baseline");
    expect(workflow).toContain("Scan release image (Trivy)");
    expect(compose).not.toContain("public.ecr.aws");
    expect(readFileSync(path.join(root, "Dockerfile.secure-images"), "utf8")).toContain("sha256:");
    const image = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(image).toContain("FROM deps AS runtime-deps");
    expect(image).toContain("npx --yes npm@12.2.1 prune --omit=dev");
  });

  it("keeps Docker smoke test on an HTTP-only bind without ACME", () => {
    const docker = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
    expect(docker).toContain('GATEWAY_DOMAIN: "http://print.example.com"');
    expect(docker).not.toContain("GATEWAY_DOMAIN: print.example.com");
  });

  it("scopes Rust supply-chain audits to the environment they validate", () => {
    const all = workflows();
    const ci = all.find((workflow) => workflow.includes("name: CI"));
    const security = all.find((workflow) => workflow.includes("name: Security and Resilience Gates"));
    const windows = all.find((workflow) => workflow.includes("name: Build Windows Installer"));
    // Supply-chain scanning has one authoritative owner. Re-running cargo-audit
    // in CI and Windows packaging adds minutes without checking a different graph.
    expect(ci).not.toContain("cargo audit");
    expect(security).toContain("cargo audit --target-os windows --target-arch x86_64");
    expect(windows).not.toContain("cargo audit");
  });

  it("builds Windows installers on every non-PR run while keeping PR smoke scoped", () => {
    const windows = readFileSync(path.join(root, ".github/workflows/build-windows.yml"), "utf8");
    expect(windows).toContain("name: Windows change filter");
    expect(windows).toContain("needs: changes");
    // Non-PR runs must always produce a fresh installer artifact. The change
    // filter remains relevant only to the smaller, PR-scoped native smoke job.
    const fullBuild = windows.split("\n  build-windows:")[1];
    const prSmoke = windows.split("\n  windows-pr-smoke:")[1]?.split("\n  build-windows:")[0];
    expect(fullBuild).toBeDefined();
    expect(prSmoke).toBeDefined();
    expect(fullBuild).toContain("if: github.event_name != 'pull_request'");
    expect(fullBuild).not.toContain("needs.changes.outputs.windows == 'true'");
    expect(fullBuild).toContain("name: Build Tauri Windows NSIS installer");
    expect(fullBuild).toContain("name: Upload Windows NSIS installer");
    expect(prSmoke).toContain("if: github.event_name == 'pull_request' && github.event.pull_request.draft == false");
    expect(prSmoke).toContain("needs.changes.outputs.agent == 'true' || needs.changes.outputs.rust == 'true'");
    expect(prSmoke).toContain("if: needs.changes.outputs.agent == 'true'");
    expect(prSmoke).toContain("if: needs.changes.outputs.rust == 'true'");
    expect(prSmoke).not.toContain("Build Tauri Windows NSIS installer");
    expect(prSmoke).not.toContain("actions/upload-artifact@");
    expect(windows).not.toMatch(/^[ ]{4}paths:$/m);
    for (const requiredPath of ["agent/*", "src-tauri/*", "src/desktop/*", "src/components/*", "src/i18n/*", "src/lib/*"]) {
      expect(windows).toContain(requiredPath);
    }
  });

  it("isolates manual Windows releases while cancelling superseded push workflows", () => {
    const windows = readFileSync(path.join(root, ".github/workflows/build-windows.yml"), "utf8");
    const release = windows.split("\n  build-windows:")[1];
    const pullRequest = windows.split("\n  windows-pr-smoke:")[1]?.split("\n  build-windows:")[0];
    expect(release).toBeDefined();
    expect(pullRequest).toBeDefined();
    // Main pushes replace older push runs; manual and merge-queue builds
    // keep independent run IDs, while PR smoke supersedes older PR edits.
    expect(release).toContain("group: windows-build-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}");
    expect(release).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(pullRequest).toContain("group: windows-pr-smoke-${{ github.ref }}");
    expect(pullRequest).toContain("cancel-in-progress: true");
  });

  it("separates Docker and security jobs by commit SHA or independent run ID", () => {
    const cases: Array<[string, string, string]> = [
      [".github/workflows/docker.yml", "docker-scan-${{ matrix.variant }}-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
      [".github/workflows/docker.yml", "docker-runtime-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
      [".github/workflows/static-security.yml", "static-codeql-${{ matrix.language }}-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
      [".github/workflows/static-security.yml", "static-deps-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
      [".github/workflows/static-security.yml", "static-secrets-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
      [".github/workflows/security-supply-chain.yml", "security-supply-${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
    ];
    for (const [workflow, group, policy] of cases) {
      const source = readFileSync(path.join(root, workflow), "utf8");
      const at = source.indexOf("group: " + group);
      expect(at, workflow + ": " + group).toBeGreaterThanOrEqual(0);
      const nextLine = source.slice(at).split("\n")[1]?.trim();
      expect(nextLine, workflow + ": " + group).toBe(policy);
    }
    // PR smoke/preflight continues to replace only older runs for the same PR.
    const docker = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
    expect(docker).toContain("group: docker-pr-${{ github.ref }}\n      cancel-in-progress: true");
  });

  it("keeps Caddy's forwarded-header security contract warning-free", () => {
    const caddy = readFileSync(path.join(root, "Caddyfile"), "utf8");
    expect(caddy).toContain("header_up X-Forwarded-For {http.request.remote.host}");
    expect(caddy).not.toContain("header_up Host {http.request.host}");
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
