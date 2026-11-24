import { receiptGeometry } from "./helpers/odoo-printer-geometry.mjs";
/**
 * Dependency-free execution of the REAL Odoo POS modules in an isolated Node
 * module realm. Odoo imports and the printer/DOM are explicit external
 * boundaries; printReceipt and renderGatewayReceiptJpeg are never replaced.
 * Run: node --no-warnings --experimental-vm-modules --test tests/current-run-pos.node.test.mjs
 * This does not replace an Odoo browser or hardware acceptance test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { webcrypto } from 'node:crypto';

const root = resolve(import.meta.dirname || dirname(new URL(import.meta.url).pathname), '..');
const addon = resolve(root, 'odoo_addons19/print_gateway/static/src/js');

function harness({ fontReady = Promise.resolve(), writeResponses = [] } = {}) {
  const seen = { canvasCalls: 0, imageWaits: 0, submissions: [], writes: [], rasterizedFontState: [], notifications: [] };
  const node = {
    querySelectorAll() { return []; },
    classList: { add() {}, toggle() {} },
    style: { setProperty() {}, set width(value) { this._width = value; }, get width() { return this._width; } },
    getBoundingClientRect() { return { width: parseFloat(this.style.width) }; },
    get scrollHeight() { return 280; },
    get scrollWidth() { return parseFloat(this.style.width); },
  };
  const document = { fonts: { ready: fontReady, status: 'loading' } };
  class PosStore {
    getOrder() { return this.currentOrder; }
    async printReceipt() { return 'NATIVE'; }
    async sendOrderInPreparation() { return true; }
    async printChanges() { return true; }
    async printOrderChanges() { return { successful: true }; }
    generateOrderChange(order) {
      return { orderData: { __gateway_order_id: order.id, __gateway_session_id: 11 }, changes: [] };
    }
    async generateReceiptsDataToPrint(orderData) { return [{ orderData: { ...orderData } }]; }
  }
  const base = { ...Object.getOwnPropertyDescriptors(PosStore.prototype) };
  const patch = (target, extension) => {
    const superMethods = {};
    for (const [key, descriptor] of Object.entries(base)) {
      if (typeof descriptor.value === 'function') superMethods[key] = descriptor.value;
    }
    Object.setPrototypeOf(extension, superMethods);
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(extension));
  };
  const stubs = {
    '@web/core/utils/patch': { patch },
    '@web/core/l10n/translation': { _t: (value) => value },
    '@web/core/confirmation_dialog/confirmation_dialog': { ConfirmationDialog: class {} },
    '@point_of_sale/app/services/pos_store': { PosStore },
    '@point_of_sale/app/models/utils/order_change': { changesToOrder: () => ({ new: [], cancelled: [], noteUpdate: [] }) },
    '@web/core/utils/render': { renderToElement: () => node },
    '@point_of_sale/app/screens/receipt_screen/receipt/order_receipt': { OrderReceipt: { template: 'OrderReceipt' } },
    '@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup': { RetryPrintPopup: class {} },
    '@point_of_sale/app/utils/html-to-image': { toCanvas: async (_node, options) => {
      seen.canvasCalls += 1;
      seen.rasterizedFontState.push(document.fonts.status);
      return { width: options.canvasWidth, height: options.canvasHeight, getContext: () => ({ fillRect() {} }), toDataURL: () => 'data:image/jpeg;base64,VALIDJPEG' };
    } },
    '@point_of_sale/utils': { waitImages: async () => { seen.imageWaits += 1; } },
  };
  const context = vm.createContext({ document, crypto: webcrypto, setTimeout, clearTimeout, console: { info() {}, warn() {}, log() {}, error() {} }, Date, performance, Uint8Array });
  const loaded = new Map();
  async function importSource(file) {
    const name = resolve(file);
    if (loaded.has(name)) return loaded.get(name);
    const source = readFileSync(name, 'utf8');
    const mod = new vm.SourceTextModule(source, { context, identifier: name });
    loaded.set(name, mod);
    await mod.link(async (specifier, referencingModule) => {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(referencingModule.identifier), specifier + '.js');
        return importSource(target);
      }
      if (stubs[specifier]) {
        const exports = stubs[specifier];
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context, identifier: specifier });
      }
      throw new Error(`Unrecognized Odoo import: ${specifier}`);
    });
    return mod;
  }
  async function init(moduleName) {
    const mod = await importSource(resolve(addon, moduleName));
    await mod.evaluate();
    return mod.namespace;
  }
  const store = new PosStore();
  store.currentOrder = { id: 101, uuid: 'receipt-a', isSynced: true, nb_print: 0 };
  store.session = { id: 11 };
  store.config = { id: 12 };
  store.company = { id: 13 };
  store.notification = { add: (message, options) => seen.notifications.push({ message, options }) };
  store.env = { services: { user: { userId: 14 }, renderer: { toHtml: async () => node, whenMounted: async ({ el, callback }) => callback(el) } } };
  store.dialog = { add: (_, options) => { seen.retryDialog = options; } };
  store.unwatched = { printers: [] };
  store.models = { 'product.product': { get: () => ({ parentPosCategIds: [] }) }, 'pos.prep.display': [] };
  store.syncAllOrders = async () => {};
  store.data = {
    call: async (_, method, __, kwargs) => {
      if (method === 'is_gateway_printing_enabled') return true;
      if (method === 'get_gateway_receipt_geometry') return receiptGeometry(384);
      if (method === 'action_print_gateway_receipt') {
        seen.submissions.push(kwargs);
        return { status: 'queued', gateway_enabled: true };
      }
      throw new Error(`unexpected method ${method}`);
    },
    silentCall: async (_, method, args) => {
      assert.equal(method, 'write');
      seen.writes.push(args);
      return writeResponses.length ? writeResponses.shift() : true;
    },
  };
  return { seen, document, node, init, store };
}

test('receipt image waits for mounted-layout font readiness before measuring/rasterizing', async () => {
  let release;
  const fontReady = new Promise((resolveReady) => { release = resolveReady; });
  const h = harness({ fontReady });
  const { renderGatewayReceiptJpeg } = await h.init('receipt_raster.js');
  let settled = false;
  const raster = renderGatewayReceiptJpeg(h.node, { renderer: h.store.env.services.renderer, geometry: receiptGeometry(384) });
  raster.then(() => { settled = true; });
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(h.seen.canvasCalls, 0, 'image must not rasterize before fonts.ready completes');
  assert.equal(settled, false);
  h.document.fonts.status = 'loaded';
  release();
  assert.equal(await raster, 'VALIDJPEG');
  assert.deepEqual(h.seen.rasterizedFontState, ['loaded']);
});

test('receipt retry after failed silent counter write repairs bookkeeping without a duplicate job', async () => {
  const h = harness({ writeResponses: [false, true] });
  await h.init('pos_print_router.js');
  assert.equal(await h.store.printReceipt(), true);
  assert.equal(h.store.currentOrder.nb_print, 0);
  assert.equal(await h.store.printReceipt(), true);
  assert.equal(h.seen.writes.length, 2, 'failed bookkeeping must be retried for the same queued operation');
  assert.equal(h.store.currentOrder.nb_print, 1);
  assert.equal(h.seen.submissions.length, 2);
  assert.equal(h.seen.submissions[0].operation_id, h.seen.submissions[1].operation_id);
  assert.equal(h.seen.submissions[0].image, h.seen.submissions[1].image);
  assert.equal(h.seen.submissions[0].geometry_fingerprint, receiptGeometry().config_fingerprint);
  assert.equal(h.seen.submissions[0].geometry_fingerprint, h.seen.submissions[1].geometry_fingerprint);
});

test('unknown selected geometry and a failed metadata request never enqueue guessed geometry and degrade to native printing', async () => {
  for (const candidate of [undefined, null, {}, 512, new Error('measurement service unavailable')]) {
    const h = harness();
    const original = h.store.data.call;
    h.store.data.call = async (...args) => {
      if (args[1] !== 'get_gateway_receipt_geometry') return original(...args);
      if (candidate instanceof Error) throw candidate;
      return candidate;
    };
    await h.init('pos_print_router.js');
    assert.equal(await h.store.printReceipt(), 'NATIVE');
    assert.equal(h.seen.submissions.length, 0);
    assert.equal(h.seen.canvasCalls, 0);
    assert.equal(h.store.gatewayReceiptPending.size, 0);
  }
});

test('an unresolved receipt replays original bytes and geometry even after current printer metadata changes', async () => {
  const h = harness();
  await h.init('pos_print_router.js');
  assert.equal(await h.store.printReceipt(), true); // queued, not terminal
  const original = h.store.data.call;
  h.store.data.call = async (...args) => {
    assert.notEqual(args[1], 'get_gateway_receipt_geometry', 'do not reformat an unresolved operation');
    return original(...args);
  };
  assert.equal(await h.store.printReceipt(), true);
  assert.equal(h.seen.canvasCalls, 1);
  assert.deepEqual(h.seen.submissions[0], h.seen.submissions[1]);
  assert.equal(h.seen.submissions[1].geometry_fingerprint, receiptGeometry().config_fingerprint);
});

test('accepted receipt statuses report submission information without claiming paper output', async () => {
  for (const status of ['queued', 'submitted', 'claimed', 'printing', 'success']) {
    const h = harness();
    const originalCall = h.store.data.call;
    h.store.data.call = async (...args) => args[1] === 'action_print_gateway_receipt'
      ? { gateway_enabled: true, status }
      : originalCall(...args);
    await h.init('pos_print_router.js');
    assert.equal(await h.store.printReceipt(), true, `status=${status}`);
    assert.equal(h.seen.notifications.length, 1);
    assert.equal(h.seen.notifications[0].options.type, 'info', `status=${status}`);
    assert.match(h.seen.notifications[0].message, /Paper output is not confirmed\./);
  }
});


test('two kitchen stations retain accepted ticket while retrying only a definitely failed station', async () => {
  const h = harness();
  await h.init('pos_print_router.js');
  const kitchenCalls = [];
  const widths = [];
  h.store.unwatched.printers = [
    { id: 10, config: { name: 'Kitchen' } },
    { id: 20, config: { name: 'Bar' } },
  ];
  const oldCall = h.store.data.call;
  h.store.data.call = async (model, method, args, kwargs) => {
    if (method === 'get_gateway_kitchen_routes') return {
      routes: [{ pos_printer_id: 10, category_ids: [1], geometry: receiptGeometry(384) },
               { pos_printer_id: 20, category_ids: [1], geometry: receiptGeometry(576) }],
      missing_routes: [],
    };
    if (method === 'action_print_gateway_kitchen') {
      kitchenCalls.push({ ...kwargs });
      widths.push(h.node.style.width);
      return kwargs.pos_printer_id === 20 && kitchenCalls.filter((call) => call.pos_printer_id === 20).length === 1
        ? { status: 'failed', gateway_enabled: true, can_retry: true, message: 'definite rejection' }
        : { status: 'submitted', gateway_enabled: true };
    }
    return oldCall(model, method, args, kwargs);
  };
  const order = { id: 101, uuid: 'prep-a', isSynced: true,
    updateLastOrderChange() {},
    uiState: { lastPrints: [] } };
  const changes = [{ new: [{ product_id: 1 }], cancelled: [], noteUpdate: [] }];
  assert.equal(await h.store.printChanges(order, changes, false, h.store.unwatched.printers), false);
  assert.equal(kitchenCalls.length, 2);
  assert.deepEqual(widths, [`${384 * 96 / 203}px`, `${576 * 96 / 203}px`]);
  assert.equal(order.uiState.lastPrints.length, 0);
  assert.equal(typeof h.seen.retryDialog?.retry, 'function');
  assert.equal(await h.seen.retryDialog.retry(), true);
  assert.equal(kitchenCalls.length, 3, 'only one definite failure is resubmitted');
  assert.deepEqual(kitchenCalls.map((c) => c.pos_printer_id), [10, 20, 20]);
  assert.notEqual(kitchenCalls[1].operation_id, kitchenCalls[2].operation_id,
    'a definitive rejection should get a fresh retry key');
  assert.equal(order.uiState.lastPrints.length, 1);
});

test('unknown kitchen station outcome must not trigger a second physical submission', async () => {
  const h = harness();
  await h.init('pos_print_router.js');
  const kitchenCalls = [];
  const oldCall = h.store.data.call;
  h.store.unwatched.printers = [{ id: 10, config: { name: 'Kitchen' } }, { id: 20, config: { name: 'Bar' } }];
  h.store.data.call = async (model, method, args, kwargs) => {
    if (method === 'get_gateway_kitchen_routes') return { routes: [
      { pos_printer_id: 10, category_ids: [], geometry: receiptGeometry(384) },
      { pos_printer_id: 20, category_ids: [], geometry: receiptGeometry(576) },
    ], missing_routes: [] };
    if (method === 'action_print_gateway_kitchen') {
      kitchenCalls.push({ ...kwargs });
      return { status: kwargs.pos_printer_id === 20 ? 'unknown' : 'submitted', gateway_enabled: true };
    }
    return oldCall(model, method, args, kwargs);
  };
  const order = { id: 101, uuid: 'prep-unknown', isSynced: true,
    updateLastOrderChange() {}, uiState: { lastPrints: [] } };
  const changes = [{ new: [{ product_id: 1 }], cancelled: [], noteUpdate: [] }];
  assert.equal(await h.store.printChanges(order, changes, false, h.store.unwatched.printers), false);
  assert.equal(await h.store.printChanges(order, changes, false, h.store.unwatched.printers), false);
  assert.equal(kitchenCalls.length, 2, 'retry suppressed for both accepted and unknown stations');
  assert.equal(h.seen.retryDialog, undefined);
});


test('receipt rejects a contradictory transport status rather than claiming Gateway acceptance', async () => {
  const h = harness();
  await h.init('pos_print_router.js');
  const original = h.store.data.call;
  let calls = 0;
  const keys = [];
  h.store.data.call = async (model, method, args, kwargs) => {
    if (method === 'action_print_gateway_receipt') {
      calls += 1;
      keys.push(kwargs.operation_id);
      return calls === 1
        ? { status: 'submitted', gateway_enabled: false }
        : { status: 'submitted', gateway_enabled: true };
    }
    return original(model, method, args, kwargs);
  };
  assert.equal(await h.store.printReceipt(), false, 'gateway_enabled:false cannot mean accepted');
  assert.equal(h.store.currentOrder.nb_print, 0);
  assert.equal(await h.store.printReceipt(), true);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'untrusted response cannot release operation identity');
  assert.equal(h.store.currentOrder.nb_print, 1);
});

test('kitchen gateway rejects accepted-looking status with invalid gateway ownership', async () => {
  const h = harness();
  await h.init('pos_print_router.js');
  const original = h.store.data.call;
  h.store.data.call = async (model, method, args, kwargs) =>
    method === 'action_print_gateway_kitchen' ? { status: 'submitted', gateway_enabled: false }
      : original(model, method, args, kwargs);
  const response = await h.store.printOrderChanges({ orderData: {
    __gateway_order_id: 101, __gateway_session_id: 11, __gateway_print_id: 'kitchen-operation-77',
  } }, {}, 10, receiptGeometry(384));
  assert.equal(response.successful, false);
  assert.equal(response.gatewayOutcome, 'unknown');
  assert.equal(response.canRetry, false);
});


for (const canRetry of [undefined, false, "false", 0]) {
  test(`receipt failed status with can_retry=${String(canRetry)} keeps original operation rather than minting new paper`, async () => {
    const h = harness();
    await h.init('pos_print_router.js');
    const original = h.store.data.call;
    let count = 0;
    h.store.data.call = async (model, method, args, kwargs) => {
      if (method !== 'action_print_gateway_receipt') return original(model, method, args, kwargs);
      h.seen.submissions.push(kwargs);
      count += 1;
      return count === 1
        ? { gateway_enabled: true, status: 'failed', ...(canRetry === undefined ? {} : { can_retry: canRetry }) }
        : { gateway_enabled: true, status: 'queued', can_retry: false };
    };
    assert.equal(await h.store.printReceipt(), false, 'an unproven failed status never counts as accepted output');
    assert.equal(h.store.currentOrder.nb_print, 0);
    assert.equal(await h.store.printReceipt(), true, 'recovery only replays the original durable print intent');
    assert.equal(h.seen.submissions.length, 2);
    assert.equal(h.seen.submissions[0].operation_id, h.seen.submissions[1].operation_id);
    assert.equal(h.seen.submissions[0].image, h.seen.submissions[1].image);
    assert.equal(h.seen.submissions[0].geometry_fingerprint, h.seen.submissions[1].geometry_fingerprint);
  });
}
