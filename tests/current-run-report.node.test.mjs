/**
 * Exercises the REAL Odoo report interceptor via its production registry
 * registration. Odoo's registry, ORM and notification UI are external boundaries.
 * Run: node --no-warnings --experimental-vm-modules --test tests/current-run-report.node.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { webcrypto } from 'node:crypto';
const root = resolve(import.meta.dirname || dirname(new URL(import.meta.url).pathname), '..');
const addon = resolve(root, 'odoo_addons/print_gateway/static/src/js');

async function harness() {
  const seen = { submissions: [], notifications: [], reports: new Map() };
  const registry = { category: (category) => {
    assert.equal(category, 'ir.actions.report handlers');
    return { add: (name, handler) => seen.reports.set(name, handler) };
  } };
  const stubs = {
    '@web/core/registry': { registry },
    '@web/core/l10n/translation': { _t: (value) => value },
    '@web/core/confirmation_dialog/confirmation_dialog': { ConfirmationDialog: class {} },
  };
  const context = vm.createContext({ setTimeout, clearTimeout, console, Date, Uint8Array, crypto: webcrypto });
  const loaded = new Map();
  async function readModule(file) {
    file = resolve(file);
    if (loaded.has(file)) return loaded.get(file);
    const mod = new vm.SourceTextModule(readFileSync(file, 'utf8'), { context, identifier: file });
    loaded.set(file, mod);
    await mod.link((specifier, importer) => {
      if (specifier.startsWith('.')) return readModule(resolve(dirname(importer.identifier), specifier + '.js'));
      if (stubs[specifier]) return new vm.SyntheticModule(Object.keys(stubs[specifier]), function () {
        for (const [key, value] of Object.entries(stubs[specifier])) this.setExport(key, value);
      }, { context, identifier: specifier });
      throw new Error('unknown import ' + specifier);
    });
    return mod;
  }
  await (await readModule(resolve(addon, 'report_interceptor.js'))).evaluate();
  const handler = seen.reports.get('silent_gateway_handler');
  assert.equal(typeof handler, 'function');
  let nextResponse = async () => ({ status: 'unknown', has_binding: true, dispatched: true });
  const orm = { call: async (model, method, args, kwargs) => {
    seen.submissions.push({ model, method, args, kwargs: structuredClone(kwargs) });
    return nextResponse(kwargs);
  } };
  const env = {
    services: {
      orm, user: { userId: 77 }, company: { currentCompany: { id: 11 } },
      notification: { add: (message, options) => seen.notifications.push({ message, options }) },
      action: { doAction() {} },
    },
  };
  const action = { type: 'ir.actions.report', report_type: 'qweb-pdf', report_name: 'account.report_invoice', id: 42, context: {} };
  return { seen, handler, env, action, setResponse: (fn) => { nextResponse = fn; } };
}

test('unresolved report operations are company-scoped despite an ORM service shared across companies', async () => {
  const { seen, handler, env, action } = await harness();
  assert.equal(await handler(action, { active_ids: [99] }, env), true);
  env.services.company.currentCompany.id = 22;
  assert.equal(await handler(action, { active_ids: [99] }, env), true);
  assert.equal(seen.submissions.length, 2);
  assert.notEqual(seen.submissions[0].kwargs.operation_id, seen.submissions[1].kwargs.operation_id,
    'same record/report in a different company is not the same print operation');
});

test('missing and malformed report status must not bypass bound-print recovery', async () => {
  const h = await harness();
  h.setResponse(async () => ({}));
  assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
  assert.match(h.seen.notifications.at(-1).message, /no reliable status/);
  assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
  assert.equal(h.seen.submissions[0].kwargs.operation_id, h.seen.submissions[1].kwargs.operation_id,
    'ambiguous response should reuse identical operation identity within one company');
});

test('definitely unbound PDF report falls back to native action', async () => {
  const h = await harness();
  h.setResponse(async () => ({ has_binding: false, dispatched: false, status: 'no_binding' }));
  assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), false);
});


test('contradictory or incomplete unbound reply cannot reopen native PDF or lose the print identity', async () => {
  const replies = [
    { has_binding: false, dispatched: true, success: true, status: 'submitted' },
    { has_binding: false, dispatched: true, success: false, status: 'unknown' },
    { has_binding: false, status: 'no_binding' },
    { has_binding: false, dispatched: 'false', status: 'no_binding' },
    { has_binding: false, dispatched: false, status: 'success', success: true },
    { has_binding: false, dispatched: false, status: 'no_binding', error: 'internal-remote-secret' },
  ];
  for (const reply of replies) {
    const h = await harness();
    h.setResponse(async () => reply);
    assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true,
      'conflicting response must not authorize native printing');
    const notice = h.seen.notifications.at(-1);
    assert.equal(notice.options.type, 'warning');
    assert.equal(notice.options.sticky, true);
    assert.match(notice.message, /Native PDF download cancelled/);
    assert.doesNotMatch(notice.message, /internal-remote-secret/);
    assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
    assert.equal(h.seen.submissions.length, 2);
    assert.equal(h.seen.submissions[0].kwargs.operation_id, h.seen.submissions[1].kwargs.operation_id,
      'uncertain route cannot mint a second independent physical print attempt');
  }
});


test('bound RPC boolean flags must be actual booleans before an operation is settled', async () => {
  for (const reply of [
    { has_binding: true, dispatched: 'true', success: true, status: 'submitted' },
    { has_binding: true, dispatched: true, success: 'true', status: 'success' },
    { has_binding: true, dispatched: 'false', success: false, status: 'queued' },
    { has_binding: true, dispatched: undefined, success: true, status: 'claimed' },
  ]) {
    const h = await harness();
    h.setResponse(async () => reply);
    assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
    const notice = h.seen.notifications.at(-1);
    assert.equal(notice.options.type, 'warning', 'untrusted truthy flags cannot grant admission');
    assert.equal(notice.options.sticky, true);
    assert.match(notice.message, /no reliable status/);
    assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
    assert.equal(h.seen.submissions[0].kwargs.operation_id, h.seen.submissions[1].kwargs.operation_id);
  }
});

test('report notifications never echo untrusted RPC error or progress content', async () => {
  const cases = [
    { status: 'failed', dispatched: false, success: false, code: 'PRINTER_OFFLINE', error: 'SQL password=PRIVATE_DATABASE_SECRET' },
    { status: 'unexpected', dispatched: false, success: false, error: 'SQL password=PRIVATE_DATABASE_SECRET' },
    { status: 'queued', dispatched: true, success: false, message: 'SQL password=PRIVATE_DATABASE_SECRET' },
    { status: 'submitted', dispatched: true, success: true, message: 'SQL password=PRIVATE_DATABASE_SECRET' },
  ];
  for (const reply of cases) {
    const h = await harness();
    h.setResponse(async () => ({ has_binding: true, ...reply }));
    assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
    const notice = h.seen.notifications.at(-1);
    assert.equal(typeof notice.message, 'string');
    assert.doesNotMatch(notice.message, /SQL|password|PRIVATE_DATABASE_SECRET/);
    assert.match(notice.message, /Print|printer|printing/);
  }
});

test('overlapping report actions coalesce during async server dispatch', async () => {
  const h = await harness();
  let release;
  h.setResponse(() => new Promise((r) => { release = r; }));
  const first = h.handler(h.action, { active_ids: [99] }, h.env);
  await new Promise((r) => setImmediate(r));
  assert.equal(await h.handler(h.action, { active_ids: [99] }, h.env), true);
  assert.equal(h.seen.submissions.length, 1);
  release({ status: 'submitted', has_binding: true, dispatched: true, success: true });
  assert.equal(await first, true);
});
