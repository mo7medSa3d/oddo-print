import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');

test('License-Only Gateway stats omit legacy print/fleet queries and expose control-plane metrics', () => {
  const stats = read('src/app/api/platform/stats/route.ts');
  const dashboard = read('src/app/platform/dashboard/page.tsx');

  // Stats API queries only license/control-plane tables.
  assert.match(stats, /\.from\(tenants\)/, 'stats API must query tenants');
  assert.match(stats, /\.from\(tenantSubscriptions\)/, 'stats API must query tenantSubscriptions');
  assert.match(stats, /\.from\(apiKeys\)/, 'stats API must query apiKeys');
  assert.match(stats, /FROM\s+subscription_requests\b/i, 'stats API must query subscription_requests');

  // Legacy cloud print/fleet tables and zeroed compatibility fields must not remain in License-Only mode.
  assert.doesNotMatch(stats, /\b(printJobs|printers|agents)\b(?=\s*[,}])[\s\S]*from\s+["'][^"']*db\/schema["']/, 'stats API must not import printJobs, printers, or agents from schema');
  assert.doesNotMatch(stats, /\.(from|innerJoin|leftJoin)\(\s*(printJobs|printers|agents)\b/, 'stats API must not query printJobs, printers, or agents');
  assert.doesNotMatch(stats, /\bFROM\s+(print_jobs|printers|agents)\b/i, 'stats API must not run raw SQL against print_jobs, printers, or agents');
  assert.doesNotMatch(stats, /\b(queueNow|agents|printers|logicalUsage|verifiedPrinters|jobs24h|jobs24hHourly)\s*:/, 'stats API must not return zeroed legacy print/fleet fields');
  assert.match(stats, /\blicenseKeys\s*:/, 'stats API must expose licenseKeys metrics');
  assert.match(stats, /\bintegrations\s*:/, 'stats API must expose integrations metrics');

  // Dashboard presents real license/subscription/integration control-plane metrics without legacy fields or charts.
  assert.doesNotMatch(dashboard, /PrintThroughputChart|FleetHealthChart|SubscriptionMixChart/, 'dashboard must not render legacy charts');
  assert.doesNotMatch(dashboard, /\b(queueNow|agents|printers|logicalUsage|verifiedPrinters|jobs24h)\s*:/, 'dashboard Stats type must not declare legacy print/fleet fields');
  assert.doesNotMatch(dashboard, /\bdata\.(queueNow|agents|printers|logicalUsage|verifiedPrinters|jobs24h)\b/, 'dashboard must not render legacy zeroed print/fleet fields');
  assert.match(dashboard, /data\.tenants\.total/, 'dashboard must show total workspaces');
  assert.match(dashboard, /data\.business\.active/, 'dashboard must show active workspaces');
  assert.match(dashboard, /data\.business\.pendingRequests/, 'dashboard must show pending subscription requests');
  assert.match(dashboard, /data\.business\.expiringSoon/, 'dashboard must show expiring subscriptions');
  assert.match(dashboard, /\bdata\.licenseKeys\b/, 'dashboard must render real licenseKeys metrics');
  assert.match(dashboard, /\bdata\.integrations\b/, 'dashboard must render real integrations metrics');
  assert.doesNotMatch(dashboard, /queued:\s*stats\?\.jobs24h\.queued/, 'historical jobs cannot masquerade as current backlog');
});
