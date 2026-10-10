import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import test from 'node:test';

// Exercises the real Gateway PATCH and manager DELETE handlers; only Next,
// Drizzle and database transactions are replaced because the runtime DB is
// unavailable. PostgreSQL's int4 limit is authoritative for the API contract.
const source = (path) => stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'transform' });
const table = new Proxy({}, { get: (_, key) => `apiKeys.${String(key)}` });
const sql = (parts, ...vals) => parts.reduce((s, part, i) => s + part + (i < vals.length ? String(vals[i]) : ''), '');
const noop = () => {};
async function load(path, deps) {
  const context = createContext({ Date, Error, Request, Response, console });
  const module = new SourceTextModule(source(path), { context });
  await module.link((name) => {
    assert.ok(Object.hasOwn(deps, name), `unmocked external boundary: ${name}`);
    const entries = deps[name];
    return new SyntheticModule(Object.keys(entries), function () {
      for (const [key, value] of Object.entries(entries)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

async function configFixture({ readOnly = false } = {}) {
  const events = [];
  const tx = {
    execute: async (query) => { events.push({ keyLock: query }); return { rows: [{ id: 'key' }] }; },
    update: () => ({ set: (values) => {
      events.push({ write: values });
      return { where: () => ({ returning: async () => [
        { enabled: values.odooEnabled, revision: values.odooEnabledRevision, updatedAt: new Date(0) },
      ] }) };
    } }),
  };
  const db = { transaction: (fn) => { events.push('transaction'); return fn(tx); }, query: { apiKeys: { findFirst: noop } } };
  const api = await load('src/app/api/odoo/configuration/route.ts', {
    'next/server': { NextResponse: { json: (value, options) => Response.json(value, options) } },
    'drizzle-orm': { and: (...args) => args, eq: (a,b) => [a,b], lt: (a,b) => [a,b], sql },
    '../../../../db': { db }, '../../../../db/schema': { apiKeys: table },
    '../../../../lib/manager-auth': { validateWorkspaceManager: async () => null },
    '../../../../lib/authorization': { requireManagerPermission: noop },
    '../../../../lib/odoo-auth': { validateOdooKey: async () => ({ id: 'key', tenantId: 'tenant', hashedKey: 'valid', readOnly }) },
    '../../../../lib/audit': { writeAuditEvent: async () => events.push('audit') },
    '../../../../lib/entitlements': { isTenantBillingError: () => false, requireTenantBillingAccess: async () => events.push('bill-check') },
  });
  async function patch(revision, enabled) {
    const req = new Request('https://gateway.test/api/odoo/configuration', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, enabled }),
    });
    return api.PATCH(req);
  }
  return { patch, events };
}

test('PATCH rejects revision above PostgreSQL signed int4 range before DB or audit side effects', async () => {
  const f = await configFixture();
  for (const revision of [2147483648, 2147483650, 1e15, -1, 1.25]) {
    const response = await f.patch(revision, true);
    assert.equal(response.status, 400, `revision ${revision}`);
  }
  assert.equal(f.events.length, 0, 'an invalid control-plane revision must not start a transaction');
});

test('PATCH locks the integration key before billing so print admission cannot deadlock with activation', async () => {
  const f = await configFixture();
  const response = await f.patch(6, true);
  assert.equal(response.status, 200);
  const lockIndex = f.events.findIndex((event) => typeof event === 'object' && event.keyLock?.includes('FROM api_keys') && event.keyLock?.includes('FOR UPDATE'));
  const billingIndex = f.events.indexOf('bill-check');
  const writeIndex = f.events.findIndex((event) => typeof event === 'object' && event.write);
  assert.ok(lockIndex >= 0, 'live key must be row-locked before checking subscription');
  assert.ok(billingIndex > lockIndex, 'must not lock subscription first (the opposite order from Odoo print admission)');
  assert.ok(writeIndex > billingIndex, 'billable mutation remains after subscription decision');
});

test('PATCH accepts the highest representable revision and still fences state', async () => {
  const f = await configFixture();
  const response = await f.patch(2147483647, true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 2147483647);
  assert.ok(f.events.includes('bill-check'));
  assert.ok(f.events.includes('audit'));
});

test('PATCH disables an enabled service without requiring a billable entitlement', async () => {
  const f = await configFixture();
  const response = await f.patch(8, false);
  assert.equal(response.status, 200);
  assert.ok(f.events.includes('audit'));
  assert.ok(!f.events.includes('bill-check'));
});

test('PATCH rotated read-only integration key cannot mutate Odoo enabled state', async () => {
  const f = await configFixture({ readOnly: true });
  const response = await f.patch(8, true);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'API_KEY_READ_ONLY');
  assert.equal(f.events.length, 0);
});

async function deletionFixture() {
  const zstring = { trim() { return this; }, min() { return this; }, max() { return this; }, optional() { return this; } };
  const revisions = [];
  const tx = {
    execute: async () => ({ rows: [] }),
    select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: 'key' }] }) }) }),
    update: () => ({ set: (values) => {
      revisions.push(values.odooEnabledRevision);
      return { where: () => ({ returning: async () => [{ id: 'key', revokedAt: new Date() }] }) };
    } }),
  };
  const db = { transaction: (fn) => fn(tx) };
  const manager = { tenantId: 'tenant', userId: 'user' };
  const api = await load('src/app/api/odoo/keys/route.ts', {
    '../../../../lib/tenant-guard': { requireActiveTenantInTransaction: noop },
    '../../../../lib/manager-mutation-authorization': { requireManagerActorInTransaction: noop, ManagerMutationAuthorityChangedError: class extends Error {} },
    '../../../../lib/action-error': { ActionError: class extends Error {} },
    'next/server': { NextResponse: { json: (value, options) => Response.json(value, options) } },
    '../../../../db': { db }, '../../../../db/schema': { apiKeys: table },
    '../../../../lib/manager-auth': { validateWorkspaceManager: async () => manager },
    '../../../../lib/authorization': { requireManagerPermission: noop },
    '../../../../lib/odoo-auth': { generateOdooApiKey: noop },
    'drizzle-orm': { eq: (a,b) => [a,b], and: (...args) => args, desc: noop, sql },
    'zod': { z: { object: () => ({ strict: () => ({}) }), string: () => zstring } },
    '../../../../lib/audit': { writeAuditEvent: async () => {} },
    '../../../../lib/entitlements': { isTenantBillingError: () => false, requireTenantBillingAccess: noop },
  });
  return { api, revisions };
}

for (const remove of [false, true]) {
  test(`manager ${remove ? 'erasure' : 'revocation'} saturates activation revision instead of integer overflow`, async () => {
    const f = await deletionFixture();
    const response = await f.api.DELETE(new Request('https://gateway.test/api/odoo/keys', { method: 'DELETE', body: JSON.stringify({ id: 'key', remove }) }));
    assert.equal(response.status, 200);
    assert.equal(f.revisions.length, 1);
    assert.match(f.revisions[0], /LEAST\(/, 'saturating increment handles stored revision 2147483647');
    assert.match(f.revisions[0], /2147483646/);
    assert.match(f.revisions[0], /\+ 1/);
  });
}
