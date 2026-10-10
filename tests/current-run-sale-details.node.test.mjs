/**
 * Execute the real SaleDetailsButton.onClick, replacing only Odoo registrations,
 * report renderer, backend ORM and browser recovery storage boundaries.
 * This is not a visual browser or physical print test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const addon = resolve(import.meta.dirname || dirname(new URL(import.meta.url).pathname), '../odoo_addons/print_gateway/static/src/js');

async function fixture({ outcomes = [], enabled = true } = {}) {
  const submissions = [];
  const notifications = [];
  class SaleDetailsButton {
    async onClick() { return 'NATIVE'; }
  }
  const nativeClick = SaleDetailsButton.prototype.onClick;
  const patch = (prototype, extension) => {
    Object.setPrototypeOf(extension, { onClick: nativeClick });
    Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(extension));
  };
  const stubs = {
    '@web/core/utils/patch': { patch },
    '@web/core/l10n/translation': { _t: value => value },
    './gateway_limit_dialog': { gatewayServerMessage: e => e.message, showGatewayBillingLimitDialog: () => false },
    '@web/core/l10n/dates': { formatDateTime: () => 'fixed-date' },
    '@point_of_sale/app/components/navbar/sale_details_button/sale_details_button': { SaleDetailsButton },
    '@web/core/utils/render': { renderToElement: () => ({}) },
    './receipt_raster': { renderGatewayReceiptJpeg: async () => 'FIXEDJPEG' },
  };
  const context = vm.createContext({ crypto: webcrypto, luxon: { DateTime: { now: () => ({}) } },
    console: { warn() {}, error() {}, log() {} }, setTimeout, clearTimeout, Date, Uint8Array });
  const modules = new Map();
  async function imported(path) {
    if (modules.has(path)) return modules.get(path);
    const mod = new vm.SourceTextModule(readFileSync(path, 'utf8'), { context, identifier: path });
    modules.set(path, mod);
    await mod.link(async (id, source) => {
      if (stubs[id]) return new vm.SyntheticModule(Object.keys(stubs[id]), function () {
        for (const [key, value] of Object.entries(stubs[id])) this.setExport(key, value);
      }, { context, identifier: id });
      if (!id.startsWith('.')) throw new Error(`Unsupported runtime import: ${id}`);
      return imported(resolve(dirname(source.identifier), `${id}.js`));
    });
    return mod;
  }
  const mod = await imported(resolve(addon, 'pos_sale_details_router.js'));
  await mod.evaluate();
  const button = new SaleDetailsButton();
  const pos = {
    session: { id: 42 }, company: { id: 9 }, config: { id: 11 },
    env: { services: { user: { userId: 100 }, company: { currentCompany: { id: 9 } },
      }, utils: { formatCurrency: () => '' } },
    data: { call: async (_, method, args, kwargs) => {
      if (method === 'is_gateway_printing_enabled') return enabled;
      if (method === 'get_sale_details') return { lines: [] };
      if (method === 'get_gateway_sale_details_raster_width') return 384;
      if (method === 'action_print_gateway_sale_details') {
        submissions.push({ operation_id: kwargs.operation_id, image: kwargs.image });
        return outcomes.shift() ?? { gateway_enabled: true, status: 'queued' };
      }
      throw new Error(`Unexpected ORM method: ${method}`);
    } },
  };
  button.pos = pos;
  button.env = { services: { renderer: {}, notification: { add: (...values) => notifications.push(values) } } };
  return { button, pos, submissions, notifications };
}

test('contradictory Sale Details response remains unresolved and keeps exact raster for same-id retry', async () => {
  const f = await fixture({ outcomes: [{ gateway_enabled: false, status: 'submitted' },
    { gateway_enabled: true, status: 'queued' }] });
  assert.equal(await f.button.onClick(), false);
  const previous = f.pos.gatewaySaleDetailsOperations.get(42);
  assert.equal(previous.terminal, false, 'a non-Gateway status cannot terminate the operation');
  assert.equal(previous.image, 'FIXEDJPEG', 'possible admission requires byte-identical retry data');
  assert.equal((await f.button.onClick()).status, 'queued');
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[0].operation_id, f.submissions[1].operation_id);
  assert.equal(f.submissions[0].image, f.submissions[1].image);
});

test('valid terminal Gateway response ends previous attempt, later explicit click uses new identity', async () => {
  const f = await fixture({ outcomes: [{ gateway_enabled: true, status: 'submitted' },
    { gateway_enabled: true, status: 'submitted' }] });
  assert.equal((await f.button.onClick()).status, 'submitted');
  assert.equal(f.pos.gatewaySaleDetailsOperations.get(42).terminal, true);
  assert.equal((await f.button.onClick()).status, 'submitted');
  assert.notEqual(f.submissions[0].operation_id, f.submissions[1].operation_id);
});

test('disabled Gateway returns to native Odoo Sale Details handler', async () => {
  const f = await fixture({ enabled: false });
  assert.equal(await f.button.onClick(), 'NATIVE');
  assert.equal(f.submissions.length, 0);
});
