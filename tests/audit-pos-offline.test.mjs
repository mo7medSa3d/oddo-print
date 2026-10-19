import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

// Execute the actual addon modules with framework boundaries mocked. This
// offline suite requires Node's built-in modules only, never downloaded deps.
async function loadHooks(file = "pos_print_router.js") {
  let hooks;
  const mocks = {
    patch: (_prototype, extension) => { hooks = extension; },
    _t: (text, ...args) => { let index = 0; return text.replace(/%s/g, () => String(args[index++])); },
    PosStore: class {}, SaleDetailsButton: class {}, OrderReceipt: { template: "point_of_sale.OrderReceipt" },
    RetryPrintPopup: class {}, ConfirmationDialog: class {},
    changesToOrder: () => ({ new: [{ product_id: 1, quantity: 1 }], cancelled: [], noteUpdate: [] }),
    renderToElement: (name, props) => ({ name, props, classList: { add() {} } }),
    htmlToCanvas: async () => canvas(), toCanvas: async () => canvas(), waitImages: async () => {},
    formatDateTime: () => "2026-10-04",
    registry: { category: () => ({ add: (_name, handler) => { hooks = handler; } }) },
  };
  const context = vm.createContext({
    console, crypto: webcrypto, Set, Uint8Array, setTimeout, clearTimeout,
    luxon: { DateTime: { now: () => ({}) } },
  });
  const common = new vm.SyntheticModule(Object.keys(mocks), function () {
    for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
  }, { context });
  // This unit checks POS RPC/outcome logic, not pixel rendering. Supply an
  // isolated raster boundary while the real pixel/layout contract is tested
  // in tests/pos-receipt-font.test.ts against the actual module.
  const raster = new vm.SyntheticModule([
    "DEFAULT_RECEIPT_RASTER_WIDTH", "normalizedReceiptRasterWidth", "renderGatewayReceiptJpeg",
  ], function () {
    this.setExport("DEFAULT_RECEIPT_RASTER_WIDTH", 512);
    this.setExport("normalizedReceiptRasterWidth", (value) =>
      Number.isInteger(value) && value >= 288 && value <= 576 ? value : 512);
    this.setExport("renderGatewayReceiptJpeg", async () => "VALIDJPEG");
  }, { context });
  const asyncSource = await readFile(new URL("../odoo_addons/print_gateway/static/src/js/async_control.js", import.meta.url), "utf8");
  const asyncControl = new vm.SourceTextModule(asyncSource, { context });
  await asyncControl.link(() => { throw new Error("async_control has no external imports"); });
  await asyncControl.evaluate();
  const limitSource = await readFile(new URL("../odoo_addons/print_gateway/static/src/js/gateway_limit_dialog.js", import.meta.url), "utf8");
  const limits = new vm.SourceTextModule(limitSource, { context });
  await limits.link(() => common);
  const recoverySource = await readFile(new URL("../odoo_addons/print_gateway/static/src/js/operation_recovery.js", import.meta.url), "utf8");
  const recovery = new vm.SourceTextModule(recoverySource, { context });
  await recovery.link(() => { throw new Error("Unexpected recovery import"); });
  const source = await readFile(new URL(`../odoo_addons/print_gateway/static/src/js/${file}`, import.meta.url), "utf8");
  const loadedModule = new vm.SourceTextModule(source, { context });
  await loadedModule.link((name) => name === "./gateway_limit_dialog" ? limits : name === "./async_control" ? asyncControl : name === "./receipt_raster" ? raster : name === "./operation_recovery" ? recovery : common);
  await loadedModule.evaluate();
  return { hooks, exports: loadedModule.namespace, limits: limits.namespace, mocks };
}
function canvas() {
  return { width: 100, height: 100, getContext: () => ({ fillRect() {} }), toDataURL: () => "data:image/jpeg;base64,VALIDJPEG" };
}
function fixture(secondOutcome, stationCount = 2) {
  const printers = Array.from({ length: stationCount }, (_, index) => ({ id: index + 1, config: { name: `Station ${index + 1}` } }));
  const outcomes = [], notifications = [], dialogs = [];
  const order = { id: 21, uuid: "order-21", isSynced: true, uiState: { lastPrints: [] }, updateLastOrderChange() { this.consumed = (this.consumed || 0) + 1; } };
  const pos = {
    session: { id: 5 }, config: { printerCategories: [1] }, unwatched: { printers }, syncingOrders: new Set(), models: {},
    data: { call: async (_model, method) => method === "is_gateway_printing_enabled" ? true : { routes: printers.map(p => ({ pos_printer_id: p.id, category_ids: [1] })), missing_routes: [] } },
    notification: { add: (...args) => notifications.push(args) }, dialog: { add: (...args) => dialogs.push(args) },
    syncAllOrders: async () => {}, displayPrinterWarning() {}, updateLastOrderChangeIfNoDevice() {},
    generateOrderChange: () => ({ orderData: { __gateway_print_id: "operation" }, changes: {} }),
    generateReceiptsDataToPrint: async () => [{ orderData: { __gateway_print_id: "operation" } }],
    printOrderChanges: async (_data, _printer, id) => { outcomes.push(id); return id === 1 ? { successful: true } : secondOutcome; },
  };
  return { pos, order, outcomes, notifications, dialogs };
}

test("receipt renderer accepts only Odoo 19 props and configured component", async () => {
  const { exports } = await loadHooks();
  const order = { id: 21 }, component = { template: "custom.OrderReceipt" };
  const renderer = { toHtml: async (actual, props) => {
    assert.equal(actual, component);
    assert.deepEqual(Object.keys(props).sort(), ["basic_receipt", "order"]);
    assert.equal(props.order, order);
    return { classList: { add() {} } };
  } };
  assert.equal(await exports.renderReceiptImage({ orderReceiptComponent: component, env: { services: { renderer } } }, order), "VALIDJPEG");
});

test("receipt template fallback uses current component template", async () => {
  const { exports } = await loadHooks();
  assert.equal(await exports.renderReceiptImage({}, { id: 21 }), "VALIDJPEG");
});

test("mixed success/unknown kitchen batch remains unconsumed and does not replay", async () => {
  const { hooks } = await loadHooks();
  const f = fixture({ successful: false, gatewayOutcome: "unknown", canRetry: false });
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), false);
  assert.equal(f.order.uiState.lastPrints.length, 0);
  assert.equal(f.dialogs.length, 0);
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), false);
  assert.deepEqual(f.outcomes, [1, 2]);
});

test("plan refusals never create an automatic retry dialog", async () => {
  const { hooks } = await loadHooks();
  const f = fixture({ successful: false, canRetry: false });
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), false);
  assert.equal(f.dialogs.length, 0);
});

test("successful subset retry cannot consume another unknown station", async () => {
  const { hooks } = await loadHooks();
  const f = fixture({ successful: false, gatewayOutcome: "unknown", canRetry: false }, 3);
  f.pos.printOrderChanges = async (_data, _printer, id) => {
    f.outcomes.push(id);
    return id === 1 ? { successful: true } : id === 2 ? { successful: false, gatewayOutcome: "unknown", canRetry: false } : { successful: false, canRetry: true };
  };
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), false);
  f.pos.printChanges = (...args) => hooks.printChanges.call(f.pos, ...args);
  f.pos.printOrderChanges = async () => ({ successful: true });
  assert.equal(await f.dialogs[0][1].retry(), false);
  assert.equal(f.order.consumed, undefined);
});

test("new preparation cycles can print the same product change again", async () => {
  const { hooks } = await loadHooks();
  const f = fixture({ successful: true });
  f.pos.printChanges = (...args) => hooks.printChanges.call(f.pos, ...args);
  const operationIds = [];
  let generation = 0;
  f.pos.generateReceiptsDataToPrint = async () => [{ orderData: { __gateway_print_id: `operation-${++generation}` } }];
  f.pos.printOrderChanges = async (data, _printer, id) => {
    operationIds.push(data.orderData.__gateway_print_id);
    f.outcomes.push(id);
    return { successful: true };
  };
  assert.equal(await hooks.sendOrderInPreparation.call(f.pos, f.order), true);
  assert.equal(await hooks.sendOrderInPreparation.call(f.pos, f.order), true);
  assert.deepEqual(f.outcomes, [1, 2, 1, 2]);
  assert.equal(f.order.consumed, 2);
  assert.equal(new Set(operationIds).size, 4);
  assert.equal(Object.keys(f.order.uiState.gatewayKitchenOperationIds).length, 0);
});

test("activation RPC failure returns false without hardware dispatch", async () => {
  const { hooks } = await loadHooks();
  const f = fixture({ successful: true });
  f.pos.data.call = async () => { throw new Error("offline"); };
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), false);
  assert.equal(f.outcomes.length, 0);
  assert.equal(f.notifications.length, 1);
});

test("sales report failed status does not toast success", async () => {
  const { hooks } = await loadHooks("pos_sale_details_router.js");
  const notifications = [];
  const calls = [];
  const button = {
    pos: {
      session: { id: 5 },
      env: { utils: { formatCurrency: () => "$1.00" } },
      data: { call: async (model, method) => {
        calls.push([model, method]);
        if (method === "is_gateway_printing_enabled") return true;
        if (method === "get_sale_details") return { payments: [], taxes: [] };
        if (method === "action_print_gateway_sale_details") return { gateway_enabled: true, status: "failed" };
        return {};
      } },
    },
    env: { services: { notification: { add: (...args) => notifications.push(args) } } },
  };
  assert.equal(await hooks.onClick.call(button), false);
  assert.deepEqual(calls.map(([, method]) => method), [
    "is_gateway_printing_enabled",
    "get_sale_details",
    "get_gateway_sale_details_raster_width",
    "action_print_gateway_sale_details",
  ]);
  assert.equal(notifications[0][1].type, "danger");
});

test("billing dialog passes every placeholder through native Odoo interpolation", async () => {
  const { limits } = await loadHooks();
  const dialogs = [];
  assert.equal(limits.showGatewayBillingLimitDialog({ services: {
    dialog: { add: (_component, props) => dialogs.push(props) }, action: {},
  } }, {
    entitlement: "max_prints_per_period", message: "Allowance reached",
    used: 15, limit: 20, retryAfterSeconds: 61, periodEnd: "2026-10-13T12:00:00Z",
  }), true);
  assert.match(dialogs[0].body, /Used: 15/);
  assert.match(dialogs[0].body, /Plan limit: 20/);
  assert.match(dialogs[0].body, /Try again in about 2 minute\(s\)\./);
  assert.match(dialogs[0].body, /Billing period ends: /);
  assert.doesNotMatch(dialogs[0].body, /%s|undefined/);
});

test("kitchen fallback interpolates both values without replacing error content", async () => {
  const { hooks } = await loadHooks();
  const message = "Printer $& $$ $` $' reports %s";
  const f = fixture({}, 1);
  f.pos.unwatched.printers[0].config.name = "";
  f.pos.printOrderChanges = async () => ({ successful: false, canRetry: true, message: { body: message } });
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), false);
  assert.equal(f.dialogs[0][1].message, `Odoo Preparation Printer 1: ${message}`);
});

for (const file of ["report_interceptor.js", "pos_sale_details_router.js"]) {
  test(`${file} preserves literal replacement sequences in an unconfirmed error`, async () => {
    const { hooks } = await loadHooks(file);
    const message = "Printer $& $$ $` $' reports %s";
    const notifications = [];
    const notification = { add: (...args) => notifications.push(args) };
    if (file === "report_interceptor.js") {
      const handled = await hooks({ type: "ir.actions.report", report_type: "qweb-pdf",
        report_name: "sale.report_saleorder", id: 7, res_ids: [21] }, {}, {
        services: { notification, action: {}, orm: { call: async () => { throw new Error(message); } } },
      });
      assert.equal(handled, true);
    } else {
      const button = {
        pos: { session: { id: 5 }, env: { utils: { formatCurrency: () => "" } },
          data: { call: async (_model, method) => {
            if (method === "is_gateway_printing_enabled") return true;
            if (method === "action_print_gateway_sale_details") throw new Error(message);
            return {};
          } } },
        env: { services: { notification } },
      };
      assert.equal(await hooks.onClick.call(button), false);
    }
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0][0].includes(message), notifications[0][0]);
    assert.equal(notifications[0][1].type, "warning");
  });
}
