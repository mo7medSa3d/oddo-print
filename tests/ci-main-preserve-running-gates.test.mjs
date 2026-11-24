import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Supersede obsolete main runs while preserving SHA-isolated jobs and release checks. */
test("CI keeps per-SHA job groups while cancelling duplicate PR job attempts", () => {
  const source = readFileSync(".github/workflows/ci.yml", "utf8");
  const expected = "cancel-in-progress: ${{ github.event_name == 'pull_request' }}";
  const grouping = "${{ github.event_name == 'pull_request' && github.ref || github.sha }}";
  for (const group of ["agent", "quality", "gateway", "odoo"]) {
    const marker = "group: ci-" + group + "-" + grouping;
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, "missing concurrency gate " + marker);
    const lines = source.slice(at).split("\n").slice(0, 4);
    const actual = lines.find(line => line.includes("cancel-in-progress:"));
    assert.equal(actual?.trim(), expected, "main " + group + " must be isolated by SHA so a new push need not wait for old job slots");
  }
});

test("CI cancels obsolete in-progress push runs instead of merely coalescing pending runs", () => {
  const source = readFileSync(".github/workflows/ci.yml", "utf8");
  const header = source.split("\njobs:", 1)[0];
  // A shared workflow group must include the branch ref for push runs.
  // Distinct manual/release and merge-group runs cannot be coalesced.
  assert.match(header, /concurrency:\s*\n\s*group:.*github\.event_name == 'push'.*github\.ref.*github\.run_id/);
  // Push and PR both cancel superseded workflows; manual release gates do not.
  assert.match(header, /cancel-in-progress:.*github\.event_name == 'push' \|\| github\.event_name == 'pull_request'/);
  // SHA-scoped jobs allow new commits to start while older jobs shut down
  // after their parent workflow has been cancelled.
});

test("all workflows cancel superseded pushes without sacrificing manual release gates", () => {
  const policies = [
    [".github/workflows/ci.yml", "ci-run"],
    [".github/workflows/docker.yml", "docker-run"],
    [".github/workflows/build-windows.yml", "windows-run"],
    [".github/workflows/security-supply-chain.yml", "security-supply-run"],
    [".github/workflows/static-security.yml", "static-security-run"],
    [".github/workflows/native-backports.yml", "native-backports-run"],
  ];
  for (const [file, prefix] of policies) {
    const source = readFileSync(file, "utf8");
    const header = source.split("\njobs:")[0];
    assert.ok(header.includes("group: " + prefix + "-"), "missing unique workflow group: " + file);
    assert.match(header, /concurrency:\s*\n\s*group:.*github\.event_name == 'push'.*github\.ref.*github\.run_id/);
    assert.match(header, /cancel-in-progress:.*github\.event_name == 'push' \|\| github\.event_name == 'pull_request'/);
    assert.ok(header.includes("workflow_dispatch:"), "manual full-release gates must remain: " + file);
    assert.ok(header.includes("merge_group:"), "merge-queue validation must remain: " + file);
  }
});
