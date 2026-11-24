#!/usr/bin/env node
// High-severity npm audit gate with a narrow, explicit advisory allowlist.
//
// Why this exists instead of a bare `npm audit --audit-level=high`:
// `npm audit` has no built-in allowlist. This wrapper keeps the full `high`
// threshold and enforces strict, explicitly reviewed exceptions only when
// an upstream vulnerability has no fix and is provably dev-only.
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
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// No current high/critical npm advisories require an exception.
// A future exception must be explicitly reviewed and restricted to dev-only.
export const ALLOWED = [];

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

/** Pure policy evaluation also used by regression fixtures. Fail closed on
 * incomplete registry reports and on runtime/transitive allowlist exposure. */
export function evaluateAudit(report, status, lock, manifest = pkg, allowed = ALLOWED) {
  const errors = [];
  if (report?.error || !report?.vulnerabilities || typeof report.vulnerabilities !== "object" ||
      !report?.metadata?.vulnerabilities || !lock?.packages) {
    return ["Incomplete npm audit report or lockfile; cannot establish dependency safety"];
  }
  const findings = Object.values(report.vulnerabilities).flatMap((entry) =>
    (entry.via || []).filter((via) => via && typeof via === "object").map((via) => ({
      id: via.url ? String(via.url).split("/").pop() : via.name,
      name: entry.name,
      severity: via.severity,
    }))
  );
  const reported = new Set(findings.map((f) => f.id));
  for (const entry of allowed) {
    if (!reported.has(entry.id)) errors.push(`Stale audit allowlist entry: ${entry.id}`);
    const finding = report.vulnerabilities[entry.package];
    const nodes = finding?.nodes;
    // npm's installed-tree node list and committed lockfile must agree. Absence
    // from direct dependencies alone says nothing about runtime reachability.
    if (manifest.dependencies?.[entry.package] || !Array.isArray(nodes) || nodes.length === 0 ||
        nodes.some((node) => lock.packages[node]?.dev !== true)) {
      errors.push(`Allowlisted package is not provably dev-only: ${entry.package}`);
    }
  }
  for (const finding of findings) {
    if (!["high", "critical"].includes(finding.severity)) continue;
    if (!allowed.some((entry) => entry.id === finding.id && entry.package === finding.name)) {
      errors.push(`Unlisted ${finding.severity} advisory: ${finding.id} (${finding.name})`);
    }
  }
  const counts = report.metadata.vulnerabilities;
  if (!["high", "critical"].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) {
    errors.push("Invalid advisory severity counts");
  }
  if ((counts.high > 0 || counts.critical > 0) && !findings.some((f) => ["high", "critical"].includes(f.severity))) {
    errors.push("High/critical findings have no auditable advisory evidence");
  }
  if (status !== 0 && (status !== 1 || !(counts.high > 0 || counts.critical > 0))) {
    errors.push("npm audit failed without a high/critical vulnerability result");
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { status, stdout } = runAudit();
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    console.error("npm audit did not return valid JSON");
    process.exit(2);
  }
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const errors = evaluateAudit(report, status, lock);
  if (errors.length) {
    errors.forEach((error) => console.error(error));
    process.exit(1);
  }
  for (const entry of ALLOWED) console.log(`ALLOWED ${entry.id} ${entry.package}: ${entry.reason}`);
  console.log("OK: no unlisted high or critical npm advisories; exceptions are lockfile-proven dev-only.");
}
