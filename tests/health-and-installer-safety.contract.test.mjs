import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const workflow = readFileSync(".github/workflows/build-windows.yml", "utf8");

test("customer diagnostics retire without removing the real infrastructure health probe", () => {
  assert.equal(existsSync("src/app/api/system/health/route.ts"), false);
  assert.equal(existsSync("src/app/system-health/page.tsx"), false);
  assert.equal(existsSync("src/app/api/health/route.ts"), true);
});

test("failing Windows acceptance retains a distinctly unverified diagnostic artifact", () => {
  const verified = workflow.indexOf("- name: Upload Windows NSIS installer");
  const fallback = workflow.indexOf("- name: Upload unverified Windows installer for diagnostics");
  assert.ok(verified > 0 && fallback > verified);
  assert.match(workflow.slice(fallback), /if: failure\(\)/);
  assert.match(workflow.slice(fallback), /Yaseir-Manager-Windows-NSIS-UNVERIFIED-DIAGNOSTIC/);
  assert.match(workflow.slice(fallback), /if-no-files-found: ignore/);
  assert.match(workflow.slice(verified, fallback), /if-no-files-found: error/);
});

test("release installer artifact is gated on independent publisher trust", () => {
  const verified = workflow.indexOf("- name: Upload Windows NSIS installer");
  const untrusted = workflow.indexOf("- name: Upload untrusted Windows installer for internal testing");
  const failed = workflow.indexOf("- name: Upload unverified Windows installer for diagnostics");
  assert.ok(verified > 0 && verified < untrusted && untrusted < failed);
  assert.match(workflow.slice(verified, untrusted), /if: env.YASEIR_TRUSTED_RELEASE_SIGNING == 'true'/);
  assert.match(workflow.slice(untrusted, failed), /if: success\(\) && env.YASEIR_TRUSTED_RELEASE_SIGNING != 'true'/);
  assert.match(workflow.slice(untrusted, failed), /UNTRUSTED-TEST-ONLY/);
  assert.match(workflow, /ChainPolicy\.ApplicationPolicy\.Add/);
  assert.match(workflow, /ChainPolicy\.RevocationMode/);
  assert.doesNotMatch(workflow, /gh secret set /);
});

test("Docker checks DB-backed readiness rather than process-only liveness", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert.match(compose, /\/api\/health'(?:,\s*\{signal:\s*AbortSignal\.timeout\(\d+\)\})?\)\.then/);
  const runtime = dockerfile.split(/^FROM\s+.*\s+AS\s+runtime\s*$/im)[1];
  assert.ok(runtime, "the runtime stage must be identifiable");
  const probes = runtime.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/).filter(line => /^HEALTHCHECK\b/i.test(line));
  assert.equal(probes.length, 1, "a later HEALTHCHECK must not override the bounded readiness probe");
  assert.match(probes[0], /--timeout=5s/);
  assert.match(probes[0], /CMD node -e/);
  assert.match(probes[0], /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health'/);
  assert.match(probes[0], /AbortSignal\.timeout\(4000\)/);
  assert.match(probes[0], /process\.exit\(r\.ok\?0:1\)/);
  assert.match(probes[0], /catch\(\(\)=>process\.exit\(1\)\)/);
});
