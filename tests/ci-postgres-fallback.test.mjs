import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = "scripts/ci-postgres.sh";
const digest = "sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const ecr = "public.ecr.aws/docker/library/postgres:16.15-alpine@" + digest;
const hub = "docker.io/library/postgres:16.15-alpine@" + digest;

function runWithFakeDocker(mode) {
  const dir = mkdtempSync(join(tmpdir(), "yaseir-ci-pg-"));
  const log = join(dir, "calls");
  const dockerPath = join(dir, "docker");
  writeFileSync(dockerPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CI_PG_MOCK_LOG"
if [ "$1" = pull ]; then
  if [ "$CI_PG_MOCK_MODE" = throttle ] && [[ "$2" == public.ecr.aws/* ]]; then
    echo 'toomanyrequests: Data limit exceeded' >&2
    exit 1
  fi
  if [ "$CI_PG_MOCK_MODE" = invalid ] && [[ "$2" == public.ecr.aws/* ]]; then
    echo 'denied: invalid content digest' >&2
    exit 1
  fi
  if [ "$CI_PG_MOCK_MODE" = fallback-fails ]; then
    if [[ "$2" == public.ecr.aws/* ]]; then
      echo '429 rate exceeded' >&2
    else
      echo 'temporary failure to retrieve pinned image' >&2
    fi
    exit 1
  fi
fi
exit 0
`);
  chmodSync(dockerPath, 0o755);
  try {
    const result = spawnSync("bash", [script, "start"], {
      encoding: "utf8", timeout: 15_000,
      env: {
        ...process.env,
        PATH: dir + ":" + process.env.PATH,
        CI_PG_USER: "postgres",
        CI_PG_PASSWORD: "postgres",
        CI_PG_DATABASE: "app_db",
        CI_PG_MOCK_MODE: mode,
        CI_PG_MOCK_LOG: log,
      },
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CI postgres uses the pinned ECR image when registry is healthy", () => {
  const result = runWithFakeDocker("ok");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.includes("pull " + ecr));
  assert.ok(result.calls.includes("run --rm -d --name yaseir-ci-postgres"));
  assert.ok(result.calls.includes("--publish 127.0.0.1:5432:5432"));
  assert.ok(!result.calls.includes(hub));
});

test("CI postgres switches to identical pinned digest only when ECR returns 429", () => {
  const result = runWithFakeDocker("throttle");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.includes("pull " + ecr));
  assert.ok(result.calls.includes("pull " + hub));
  assert.ok(result.calls.includes('"' + hub + '"') || result.calls.includes(" " + hub));
  assert.ok(result.calls.indexOf("pull " + ecr) < result.calls.indexOf("pull " + hub));
});

test("CI postgres rejects non-throttling image errors without changing registries", () => {
  const result = runWithFakeDocker("invalid");
  assert.notEqual(result.status, 0);
  assert.ok(result.calls.includes("pull " + ecr));
  assert.ok(!result.calls.includes("pull " + hub));
  assert.ok(!result.calls.includes("run --rm"));
});

test("CI postgres fails rather than hiding fallback download errors", () => {
  const result = runWithFakeDocker("fallback-fails");
  assert.notEqual(result.status, 0);
  assert.ok(result.calls.includes("pull " + hub));
  assert.ok(!result.calls.includes("run --rm"));
});
