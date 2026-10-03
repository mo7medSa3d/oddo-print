#!/usr/bin/env node
// High-severity npm audit gate with a narrow, explicit advisory allowlist.
//
// Why this exists instead of a bare `npm audit --audit-level=high`:
// `npm audit` has no built-in allowlist, and the one advisory we currently
// carry has NO upstream fix available at all. Refusing to merge until a
// maintainer publishes a patched release is not a gate anyone can pass, and
// silently downgrading the severity threshold would hide future high findings
// too. So this wrapper keeps the full `high` threshold and, on failure, checks
// every high/critical finding against an explicit list instead.
//
// The allowlist is deliberately strict about two things that a plain
// `--audit-level` run would not enforce:
//
//   1. dev-only. npm reports the tree as installed; we additionally confirm the
//      vulnerable package is not reachable from `dependencies`. A production
//      install (the Docker runtime image runs `npm ci --omit=dev`) must never
//      be able to satisfy an allowlist entry, so a dev-only advisory that
//      becomes a runtime dependency fails this gate.
//   2. stale entries. If an allowlisted advisory stops being reported, the
//      entry has served its purpose and the gate fails so it gets removed.
//
// Delete an entry as soon as the upstream fix ships.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// Keep this list as short as its lifetime allows.
const ALLOWED = [
  {
    id: "GHSA-vfj7-8cjw-p6xm", // CVE-2026-93687
    package: "braces",
    reason:
      "Stack-exhaustion DoS via deeply nested brace patterns in braces' " +
      "recursive AST walkers. Affected <= 3.0.3, patched: NONE, so there is " +
      "no version to upgrade to. Only reachable as a devDependency of " +
      "eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> " +
      "micromatch, where it matches glob patterns that come from this " +
      "repository's own ESLint configuration, not from untrusted input. " +
      "Absent from the runtime image (npm ci --omit=dev). Upstream fix is " +
      "unmerged: https://github.com/micromatch/braces/pull/72",
  },
];

const allowedIds = new Set(ALLOWED.map((entry) => entry.id));
const packageIsDevOnly = (name) =>
  !(pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, name));

function runAudit() {
  try {
    const stdout = execFileSync("npm", ["audit", "--audit-level=high", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout };
  } catch (error) {
    // npm exits non-zero when vulnerabilities are found. That is the normal
    // path here, not an error, so read stdout and carry on.
    if (error && typeof error.stdout === "string") {
      return { status: error.status ?? 1, stdout: error.stdout };
    }
    throw error;
  }
}

const { status, stdout } = runAudit();

let report;
try {
  report = JSON.parse(stdout);
} catch {
  console.error("npm audit did not return JSON. Raw output follows:\n");
  console.error(stdout);
  process.exit(2);
}

// npm 7+ reports per-advisory findings under `vulnerabilities`.
const findings = Object.values(report.vulnerabilities || {}).flatMap((entry) =>
  (entry.via || [])
    .filter((via) => typeof via === "object" && via.source !== "npm")
    .map((via) => ({ id: via.url ? String(via.url).split("/").pop() : via.name, name: entry.name }))
);

const reported = new Set(findings.map((f) => f.id));

// A previously allowed advisory that is no longer reported means the
// dependency moved off the vulnerable range. The entry must be deleted.
const stale = ALLOWED.filter((entry) => !reported.has(entry.id));
if (stale.length > 0) {
  console.error("Stale audit allowlist entries (no longer reported; remove them):");
  for (const entry of stale) {
    console.error(`  ${entry.id} (${entry.package}) - no longer reported by npm audit`);
  }
  process.exit(1);
}

// Every high/critical finding must be explicitly allowlisted, and every
// allowlisted finding must actually be dev-only.
const highOrCritical = Object.entries(report.metadata?.vulnerabilities || {}).filter(
  ([, count]) => count > 0
);

const unlisted = findings.filter((f) => !allowedIds.has(f.id));
const misused = ALLOWED.filter((entry) => !packageIsDevOnly(entry.package));

if (misused.length > 0) {
  console.error("Allowlisted advisory now sits in `dependencies` and is NOT dev-only:");
  for (const entry of misused) {
    console.error(`  ${entry.id} (${entry.package}) is a runtime dependency`);
  }
  console.error("An allowlist entry may never cover a production dependency.");
  process.exit(1);
}

if (unlisted.length > 0) {
  console.error(`npm audit reported ${unlisted.length} unlisted high/critical advisory/advisories:\n`);
  for (const finding of unlisted) {
    console.error(`  ${finding.id}  ${finding.name}`);
  }
  console.error("\nNo allowlist entry covers these. Fix the dependency, or add a");
  console.error("documented entry to ALLOWED in scripts/audit-gate.mjs.");
  process.exit(1);
}

if (status !== 0 && highOrCritical.length === 0) {
  // npm failed for a reason other than high/critical findings (for example a
  // transient registry error). Do not silently treat that as a pass.
  console.error("npm audit exited non-zero without reporting any high/critical findings.");
  console.error("Treating this as a failure rather than a pass.");
  process.exit(2);
}

for (const entry of ALLOWED) {
  console.log(`ALLOWED  ${entry.id}  ${entry.package} (dev-only, no upstream fix available)`);
  console.log(`         ${entry.reason}\n`);
}

console.log("OK: no unlisted high or critical npm advisories.");