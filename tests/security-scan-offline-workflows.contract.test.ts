import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const docker = readFileSync(".github/workflows/docker.yml", "utf8");
const security = readFileSync(".github/workflows/static-security.yml", "utf8");
const dockerScan = docker.split("  docker-image-scan:")[1]?.split("\n  docker-build-runtime:")[0] ?? "";
const codeql = security.split("  codeql:")[1]?.split("\n  dependency-review:")[0] ?? "";

describe("private repository security scanning workflow", () => {
  it("runs Trivy for every pinned base image, retains reports and fails on fixable high/critical issues", () => {
    expect(dockerScan).toContain("aquasecurity/trivy-action@");
    expect(dockerScan).toContain("severity: 'CRITICAL,HIGH'");
    expect(dockerScan).toContain("ignore-unfixed: true");
    expect(dockerScan).toContain("limit-severities-for-sarif: true");
    expect(dockerScan).toContain("exit-code: '0'");
    expect(dockerScan).toContain("scripts/check-trivy-baseline.py");
    expect(dockerScan).toContain("actions/checkout@");
    expect(dockerScan).toContain("actions/upload-artifact@");
    expect(dockerScan).toContain("if-no-files-found: error");
    expect(dockerScan).not.toContain("github/codeql-action/upload-sarif@");
  });

  it("still analyzes every CodeQL language but uploads local artifacts rather than to disabled Code Scanning", () => {
    expect(codeql).toContain("github/codeql-action/init@");
    expect(codeql).toContain("github/codeql-action/analyze@");
    expect(codeql).toContain("upload: never");
    expect(codeql).toContain("scripts/check-codeql-sarif.py");
    expect(codeql).toContain("steps.analyze.outputs.sarif-output");
    expect(codeql).toContain("actions/upload-artifact@");
    expect(codeql).toContain("if-no-files-found: error");
    expect(codeql).not.toContain("security-events: write");
  });
});
