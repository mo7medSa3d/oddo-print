import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("platform stats API queries license control-plane tables and omits legacy print/fleet fields", () => {
  const source = read("src/app/api/platform/stats/route.ts");

  assert.match(source, /\.from\(tenants\)/, "must query tenants");
  assert.match(source, /\.from\(tenantSubscriptions\)/, "must query tenantSubscriptions");
  assert.match(source, /\.from\(apiKeys\)/, "must query apiKeys");
  assert.match(source, /FROM\s+subscription_requests\b/i, "must query subscription_requests");

  const schemaImport = source.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*db\/schema["']/);
  assert.ok(schemaImport, "must import tables from db/schema");
  assert.doesNotMatch(schemaImport[1], /\b(printJobs|printers|agents)\b/, "must not import legacy print/fleet tables");
  assert.doesNotMatch(source, /\.(from|innerJoin|leftJoin)\(\s*(printJobs|printers|agents)\b/, "must not query printJobs, printers, or agents");
  assert.doesNotMatch(source, /\bFROM\s+(print_jobs|printers|agents)\b/i, "must not run raw SQL against print_jobs, printers, or agents");
  assert.doesNotMatch(source, /\b(queueNow|agents|printers|logicalUsage|verifiedPrinters|jobs24h|jobs24hHourly)\s*:/, "must not expose zeroed legacy print/fleet fields");
  assert.match(source, /\blicenseKeys\s*:/, "must expose licenseKeys metrics");
  assert.match(source, /\bintegrations\s*:/, "must expose integrations metrics");
});

test("platform dashboard presents real license and integration control-plane metrics without legacy fields or charts", () => {
  const page = read("src/app/platform/dashboard/page.tsx");

  assert.doesNotMatch(page, /PrintThroughputChart|FleetHealthChart|SubscriptionMixChart/);
  assert.doesNotMatch(page, /\b(queueNow|agents|printers|logicalUsage|verifiedPrinters|jobs24h)\s*:/, "dashboard Stats type must not declare legacy print/fleet fields");
  assert.doesNotMatch(page, /\bdata\.(queueNow|agents|printers|logicalUsage|verifiedPrinters|jobs24h)\b/, "dashboard must not render legacy zeroed print/fleet fields");
  assert.match(page, /t\("v4\.admin\.totalWorkspaces"\)/);
  assert.match(page, /t\("v4\.admin\.activeWorkspaces"\)/);
  assert.match(page, /t\("v4\.admin\.pendingRequests"\)/);
  assert.match(page, /t\("v4\.admin\.expiring"\)/);
  assert.match(page, /data\.tenants\.total/);
  assert.match(page, /data\.business\.active/);
  assert.match(page, /data\.business\.pendingRequests/);
  assert.match(page, /data\.business\.expiringSoon/);
  assert.match(page, /\bdata\.licenseKeys\b/, "dashboard must render real licenseKeys metrics");
  assert.match(page, /\bdata\.integrations\b/, "dashboard must render real integrations metrics");
});
