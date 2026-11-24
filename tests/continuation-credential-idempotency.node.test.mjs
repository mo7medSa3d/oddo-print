import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const DELETED_CLOUD_RELAY_LIBS = [
  'src/lib/print-expiration.ts',
  'src/lib/print-job-service.ts',
  'src/lib/odoo-v2-admission.ts',
  'src/lib/job-delivery.ts',
  'src/lib/job-timeline.ts',
];

test('deleted cloud-print-relay admission and expiration libs are absent', () => {
  for (const path of DELETED_CLOUD_RELAY_LIBS) {
    assert.equal(existsSync(path), false, `${path} should be removed`);
  }
});

test('installation credential tables remain while legacy v2 relay tables are dropped', () => {
  const schema = readFileSync('src/db/schema.ts', 'utf8');
  const sql = readFileSync('drizzle/0000_initial_schema.sql', 'utf8');
  for (const kept of ['odoo_installations', 'odoo_installation_credentials']) {
    assert.match(schema, new RegExp(`pgTable\\("${kept}"`));
    assert.match(sql, new RegExp(`CREATE TABLE "${kept}"`));
  }
  for (const dropped of ['odoo_v2_operations', 'odoo_legacy_resolutions', 'print_jobs']) {
    assert.doesNotMatch(schema, new RegExp(`pgTable\\("${dropped}"`));
    assert.doesNotMatch(sql, new RegExp(`CREATE TABLE "${dropped}"`));
  }
});

test('legacy resolutions endpoint returns 410 Gone', () => {
  const route = readFileSync('src/app/api/odoo/installations/resolutions/route.ts', 'utf8');
  assert.match(route, /status:\s*410/);
  assert.doesNotMatch(route, /odoo_v2_operations/);
});
