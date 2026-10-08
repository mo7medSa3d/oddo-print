import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

async function fixture({ draft = false, failStation = false, syncError = false } = {}) {
  let hooks;
  const mocks = {
    patch: (_prototype, extension) => { hooks = extension; },
    _t: (message) => message,
    PosStore: class {}, OrderReceipt: class {}, RetryPrintPopup: class {},
    changesToOrder: () => ({ new: [{ product_id: 1, quantity: 1 }], cancelled: [], noteUpdate: [] }),
    renderToElement: () => ({}), gatewayServerMessage: (error) => error?.message,
    showGatewayBillingLimitDialog: () => false,
    DEFAULT_RECEIPT_RASTER_WIDTH: 512, normalizedReceiptRasterWidth: (value) => value,
    renderGatewayReceiptJpeg: async () => "JPEG",
  };
  const context = vm.createContext({ console, crypto: webcrypto, Set, Map, Uint8Array, setTimeout, clearTimeout });
  const common = new vm.SyntheticModule(Object.keys(mocks), function () {
    for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
  }, { context });
  const root = new URL("../odoo_addons/print_gateway/static/src/js/", import.meta.url);
  const controls = new vm.SourceTextModule(await readFile(new URL("async_control.js", root), "utf8"), { context });
  await controls.link(() => { throw new Error("Unexpected import"); });
  const addon = new vm.SourceTextModule(await readFile(new URL("pos_print_router.js", root), "utf8"), { context });
  await addon.link((name) => name === "./async_control" ? controls : common);
  await addon.evaluate();

  const notifications = [], dialogs = [], submissions = [], syncs = [];
  const printers = [1, 2].map((id) => ({ id, config: { name: `Station ${id}` } }));
  const order = {
    id: draft ? "new-order" : 21, uuid: "order-21", isSynced: !draft,
    isDirty: () => true, uiState: { lastPrints: [] },
    updateLastOrderChange() { this.consumed = (this.consumed || 0) + 1; },
  };
  const pos = {
    session: { id: 5 }, config: { printerCategories: new Set([1]) },
    unwatched: { printers }, syncingOrders: new Set(), models: {}, env: { services: { renderer: {} } },
    notification: { add: (...args) => notifications.push(args) },
    dialog: { add: (...args) => dialogs.push(args) }, updateLastOrderChangeIfNoDevice() {}, displayPrinterWarning() {},
    generateOrderChange: () => ({ orderData: {}, changes: {} }),
    generateReceiptsDataToPrint: async () => [{ orderData: {
      __gateway_order_id: order.id, __gateway_session_id: 5, __gateway_print_id: "operation-1",
    } }],
    data: { call: async (_model, method, _args, kwargs) => {
      if (method === "is_gateway_printing_enabled") return true;
      if (method === "get_gateway_kitchen_routes") return {
        routes: printers.map((p) => ({ pos_printer_id: p.id, category_ids: [1], raster_width: 384 })),
        missing_routes: [],
      };
      assert.equal(method, "action_print_gateway_kitchen");
      submissions.push(kwargs);
      return { status: failStation && kwargs.pos_printer_id === 2 ? "failed" : "submitted" };
    } },
    syncAllOrders: async (options = {}) => {
      if (syncError) throw new Error("Order sync unavailable");
      // Exact eligibility rule in Odoo 19 PosStore.syncAllOrders. Holding
      // syncingOrders before a first-save request silently filters it out.
      const eligible = options.orders.filter((candidate) =>
        !pos.syncingOrders.has(candidate.uuid) && (candidate.isDirty() || options.force));
      for (const candidate of eligible) {
        syncs.push({ id: candidate.id, consumed: candidate.consumed || 0 });
        candidate.id = 21;
        candidate.isSynced = true;
      }
    },
  };
  pos.printOrderChanges = (...args) => hooks.printOrderChanges.call(pos, ...args);
  pos.printChanges = (...args) => hooks.printChanges.call(pos, ...args);
  return { hooks, pos, order, notifications, dialogs, submissions, syncs,
    allowStation: () => { failStation = false; }, failSync: () => { syncError = true; } };
}

test("first draft kitchen ticket is persisted before the native syncingOrders guard", async () => {
  const f = await fixture({ draft: true });
  assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), true);
  assert.equal(f.submissions.length, 2);
  assert.equal(f.syncs[0].id, "new-order");
  assert.equal(f.syncs.at(-1).consumed, 1);
  assert.equal(f.pos.syncingOrders.size, 0);
});

test("failed first-save is reported without consuming changes, dispatch or a leaked guard", async () => {
  const f = await fixture({ draft: true, syncError: true });
  assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), false);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.order.consumed, undefined);
  assert.equal(f.pos.syncingOrders.size, 0);
  assert.equal(f.notifications.length, 1);
});

for (const syncFails of [false, true]) {
  test(`accepted subset kitchen retry synchronizes preparation state; sync failure=${syncFails}`, async () => {
    const f = await fixture({ failStation: true });
    assert.equal(await f.pos.printChanges(f.order, [{ new: [] }]), false);
    assert.equal(f.dialogs.length, 1);
    f.allowStation();
    if (syncFails) f.failSync();
    assert.equal(await f.dialogs[0][1].retry(), true);
    assert.equal(f.order.consumed, 1);
    assert.deepEqual(f.submissions.map((s) => s.pos_printer_id), [1, 2, 2]);
    if (syncFails) {
      assert.ok(f.notifications.some(([, config]) => config.type === "warning"));
    } else {
      assert.deepEqual(f.syncs, [{ id: 21, consumed: 1 }]);
    }
  });
}
