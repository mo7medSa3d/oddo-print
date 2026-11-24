#!/usr/bin/env node
// Prove the known vulnerable fixture reaches the real audit policy. A registry
// outage, process failure or unrelated advisory is not a successful negative test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAudit } from "./audit-gate.mjs";

const advisoryId = "GHSA-35jh-r3h4-6jhm";
const advisoryUrl = `https://github.com/advisories/${advisoryId}`;

try {
  assert.equal(process.argv.length, 4);
  assert.equal(process.argv[3], "1", "npm must return its vulnerability exit status");
  const directory = process.argv[2];
  const read = name => JSON.parse(readFileSync(join(directory, name), "utf8"));
  const report = read("audit.json"), lock = read("package-lock.json"), manifest = read("package.json");
  assert.equal(manifest.dependencies?.lodash, "4.17.19");
  assert.equal(lock.packages?.["node_modules/lodash"]?.version, "4.17.19");
  assert.equal(report.auditReportVersion, 2);
  assert(!report.error);
  const finding = report.vulnerabilities?.lodash;
  assert.equal(finding?.name, "lodash");
  assert(Array.isArray(finding.nodes) && finding.nodes.includes("node_modules/lodash"));
  assert(Array.isArray(finding.via) && finding.via.some(via =>
    via?.url === advisoryUrl && via.name === "lodash" && ["high", "critical"].includes(via.severity)));
  const errors = evaluateAudit(report, 1, lock, manifest, []);
  assert(errors.some(error => error === `Unlisted high advisory: ${advisoryId} (lodash)`
    || error === `Unlisted critical advisory: ${advisoryId} (lodash)`));
  assert(errors.every(error => /^Unlisted (high|critical) advisory: /.test(error)),
    "The fixture must fail on advisories, not on invalid audit evidence");
  console.log(`Known lodash fixture rejected by the audit policy for ${advisoryId}.`);
} catch {
  console.error("Known vulnerable fixture did not produce a valid expected advisory rejection.");
  process.exitCode = 1;
}
