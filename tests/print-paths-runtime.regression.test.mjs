import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

// Run the real addon methods together, mocking only Odoo/DOM/RPC boundaries.
// In particular, NEVER mock printOrderChanges when testing printChanges.
async function loadHooks(file = "pos_print_router.js", options = {}) {
  let hooks;
  const state = { widths: [], nativeCalls: 0, renders: 0 };
  const controls = {
    raster: async (_element, config) => {
      state.widths.push(config.width);
      return `JPEG-${++state.renders}`;
    },
  };
  const native = {
    printReceipt: async () => { state.nativeCalls++; return true; },
    onClick: async () => { state.nativeCalls++; return true; },
    printOrderChanges: async () => { state.nativeCalls++; return { successful: true }; },
  };
  const mocks = {
    patch: (_prototype, extension) => { Object.setPrototypeOf(extension, native); hooks = extension; },
    _t: (text, ...args) => { let i = 0; return text.replace(/%s/g, () => String(args[i++])); },
    registry: { category: () => ({ add: (_name, handler) => { hooks = handler; } }) },
    PosStore: class {}, SaleDetailsButton: class {}, OrderReceipt: { template: "receipt" },
    RetryPrintPopup: class {},
    renderToElement: (name, props) => ({ name, props }),
    changesToOrder: () => ({ new: [], cancelled: [], noteUpdate: [] }),
    formatDateTime: () => "2026-10-09",
    gatewayServerMessage: (error) => error?.message,
    showGatewayBillingLimitDialog: () => false,
  };
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} }, crypto: webcrypto, Set, Map, Uint8Array,
    setTimeout: options.setTimeout || setTimeout, clearTimeout,
    luxon: { DateTime: { now: () => ({}) } },
  });
  const common = new vm.SyntheticModule(Object.keys(mocks), function () {
    for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
  }, { context });
  const raster = new vm.SyntheticModule([
    "DEFAULT_RECEIPT_RASTER_WIDTH", "normalizedReceiptRasterWidth", "renderGatewayReceiptJpeg",
  ], function () {
    this.setExport("DEFAULT_RECEIPT_RASTER_WIDTH", 512);
    this.setExport("normalizedReceiptRasterWidth", (value) =>
      Number.isInteger(Number(value)) && Number(value) >= 288 && Number(value) <= 576 ? Number(value) : 512);
    this.setExport("renderGatewayReceiptJpeg", (...args) => controls.raster(...args));
  }, { context });
  const root = new URL("../odoo_addons/print_gateway/static/src/js/", import.meta.url);
  const asyncControl = new vm.SourceTextModule(await readFile(new URL("async_control.js", root), "utf8"), { context });
  await asyncControl.link(() => { throw new Error("Unexpected async-control import"); });
  const addonModule = new vm.SourceTextModule(await readFile(new URL(file, root), "utf8"), { context });
  await addonModule.link((name) => name === "./receipt_raster" ? raster : name === "./async_control" ? asyncControl : common);
  await addonModule.evaluate();
  return { hooks, state, controls };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const calls = [], notifications = [];
  const order = { id: 21, uuid: "order-21", isSynced: true, nb_print: 0, uiState: { lastPrints: [] } };
  const pos = {
    session: { id: 5 }, unwatched: { printers: [] }, models: {},
    env: { services: { renderer: { toHtml: async () => ({}) } }, utils: { formatCurrency: () => "$1" } },
    getOrder: () => order, syncAllOrders: async () => {},
    notification: { add: (...args) => notifications.push(args) },
    dialog: { add() {} }, displayPrinterWarning() {},
    data: {
      call: async (model, method, args, kwargs) => {
        calls.push({ model, method, args, kwargs });
        if (method === "is_gateway_printing_enabled") return true;
        if (method.endsWith("raster_width")) return 384;
        if (method === "get_sale_details") return {};
        return { gateway_enabled: true, status: "submitted" };
      },
      silentCall: async () => true,
    },
  };
  return { pos, order, calls, notifications, button: { pos, env: { services: { notification: pos.notification, renderer: pos.env.services.renderer } } } };
}
const submittedCalls = (f) => f.calls.filter((call) => call.method.startsWith("action_print_gateway_"));

test("kitchen routes execute the real dispatch method with each station's printable width", async () => {
  const { hooks, state } = await loadHooks();
  const f = fixture();
  const routes = [
    { pos_printer_id: 1, category_ids: [1], raster_width: 384 },
    { pos_printer_id: 2, category_ids: [2], raster_width: 576 },
  ];
  const call = f.pos.data.call;
  f.pos.data.call = (...args) => args[1] === "get_gateway_kitchen_routes"
    ? { routes, missing_routes: [] } : call(...args);
  f.pos.generateOrderChange = () => ({ orderData: {}, changes: {} });
  f.pos.generateReceiptsDataToPrint = async () => [{ orderData: {
    __gateway_order_id: 21, __gateway_session_id: 5, __gateway_print_id: "change-1",
  } }];
  f.pos.printOrderChanges = (...args) => hooks.printOrderChanges.call(f.pos, ...args);
  assert.equal(await hooks.printChanges.call(f.pos, f.order, [{ new: [] }]), true);
  assert.deepEqual(state.widths, [384, 576]);
  assert.deepEqual(submittedCalls(f).map((c) => c.kwargs.pos_printer_id), [1, 2]);
  assert.equal(new Set(submittedCalls(f).map((c) => c.kwargs.operation_id)).size, 2);
});

test("kitchen raster failure before submission is a retryable failure, not an unknown physical outcome", async () => {
  const { hooks, controls } = await loadHooks();
  const f = fixture();
  controls.raster = async () => { throw new Error("Invalid receipt geometry"); };
  const result = await hooks.printOrderChanges.call(f.pos, { orderData: {
    __gateway_order_id: 21, __gateway_session_id: 5, __gateway_print_id: "change-1",
  } }, undefined, 1, 384);
  assert.equal(result.successful, false);
  assert.equal(result.gatewayOutcome, "failed");
  assert.equal(result.canRetry, true);
  assert.equal(submittedCalls(f).length, 0);
});

test("lost kitchen submission response stays unknown and must not trigger automatic reprint", async () => {
  const { hooks } = await loadHooks();
  const f = fixture();
  const call = f.pos.data.call;
  f.pos.data.call = async (...args) => {
    const result = await call(...args);
    if (args[1] === "action_print_gateway_kitchen") throw new Error("Response lost");
    return result;
  };
  const result = await hooks.printOrderChanges.call(f.pos, { orderData: {
    __gateway_order_id: 21, __gateway_session_id: 5, __gateway_print_id: "change-1",
  } }, undefined, 1, 384);
  assert.equal(submittedCalls(f).length, 1);
  assert.equal(result.gatewayOutcome, "unknown");
  assert.equal(result.canRetry, false);
});

test("receipt lost-response retry reuses identical image bytes and operation identity", async () => {
  const { hooks, state } = await loadHooks();
  const f = fixture();
  const call = f.pos.data.call;
  let submission = 0;
  f.pos.data.call = async (...args) => {
    const result = await call(...args);
    if (args[1] === "action_print_gateway_receipt" && ++submission === 1) throw new Error("Response lost");
    return result;
  };
  assert.equal(await hooks.printReceipt.call(f.pos), false);
  assert.equal(await hooks.printReceipt.call(f.pos), true);
  const requests = submittedCalls(f);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].kwargs.operation_id, requests[1].kwargs.operation_id);
  assert.equal(requests[0].kwargs.image, requests[1].kwargs.image);
  assert.equal(state.renders, 1);
  assert.equal(await hooks.printReceipt.call(f.pos), true);
  assert.notEqual(submittedCalls(f)[2].kwargs.operation_id, requests[0].kwargs.operation_id);
  assert.equal(state.renders, 2);
});

for (const [label, file, method] of [
  ["receipt", "pos_print_router.js", "printReceipt"],
  ["sales details", "pos_sale_details_router.js", "onClick"],
]) {
  test(`${label} coalesces a second click while the first is still rendering`, async () => {
    const { hooks, controls } = await loadHooks(file);
    const f = fixture();
    const entered = deferred(), release = deferred();
    let renders = 0;
    controls.raster = async () => {
      if (++renders === 1) { entered.resolve(); return release.promise; }
      return "SECOND-IMAGE";
    };
    const target = method === "onClick" ? f.button : f.pos;
    const first = hooks[method].call(target);
    await entered.promise;
    let second;
    try { second = await hooks[method].call(target); }
    finally { release.resolve("FIRST-IMAGE"); }
    await first;
    assert.equal(second, false);
    assert.equal(renders, 1);
    assert.equal(submittedCalls(f).length, 1);
  });
}

test("Gateway-disabled receipt preserves native Odoo printing", async () => {
  const { hooks, state } = await loadHooks();
  const f = fixture();
  f.pos.data.call = async () => false;
  assert.equal(await hooks.printReceipt.call(f.pos), true);
  assert.equal(state.nativeCalls, 1);
  assert.equal(state.renders, 0);
});


function reportFixture() {
  const calls = [], notifications = [];
  const action = {
    type: "ir.actions.report", report_type: "qweb-pdf", id: 7,
    report_name: "account.report_invoice", context: { active_ids: [21], allowed_company_ids: [1] },
  };
  const env = { services: {
    orm: { call: async (...args) => {
      calls.push(args);
      return { has_binding: true, dispatched: true, success: true, status: "submitted" };
    } },
    notification: { add: (...args) => notifications.push(args) },
    action: { doAction() {} },
  } };
  return { calls, notifications, action, env };
}

test("invoice response allowlist never reports failed, absent or unrecognized states as success", async () => {
  const { hooks: handler } = await loadHooks("report_interceptor.js");
  for (const status of ["failed", undefined, "unexpected", "unknown", "partial"]) {
    const f = reportFixture();
    f.env.services.orm.call = async () => ({ has_binding: true, dispatched: true, success: true, status });
    assert.equal(await handler(f.action, {}, f.env), true);
    assert.notEqual(f.notifications.at(-1)[1].type, "success", `status=${status}`);
  }
  for (const status of ["queued", "submitted", "claimed", "printing", "success"]) {
    const f = reportFixture();
    f.env.services.orm.call = async () => ({ has_binding: true, dispatched: true, success: true, status });
    assert.equal(await handler(f.action, {}, f.env), true);
    assert.equal(f.notifications.at(-1)[1].type, "success", `status=${status}`);
  }
});

test("invoice retry after lost RPC response reuses operation identity; a known accepted reprint gets a new identity", async () => {
  const { hooks: handler } = await loadHooks("report_interceptor.js");
  const f = reportFixture();
  const call = f.env.services.orm.call;
  f.env.services.orm.call = async (...args) => {
    const result = await call(...args);
    if (f.calls.length === 1) throw new Error("Response lost after submission");
    return result;
  };
  assert.equal(await handler(f.action, {}, f.env), true);
  assert.equal(await handler(f.action, {}, f.env), true);
  assert.equal(f.calls[0][3].operation_id, f.calls[1][3].operation_id);
  assert.equal(await handler(f.action, {}, f.env), true);
  assert.notEqual(f.calls[1][3].operation_id, f.calls[2][3].operation_id);
});

test("concurrent invoice clicks coalesce before RPC; company scope is never coalesced", async () => {
  const { hooks: handler } = await loadHooks("report_interceptor.js");
  const f = reportFixture();
  const started = deferred(), release = deferred();
  const call = f.env.services.orm.call;
  f.env.services.orm.call = async (...args) => {
    const result = await call(...args); started.resolve(); await release.promise; return result;
  };
  const first = handler(f.action, {}, f.env);
  await started.promise;
  await handler(f.action, {}, f.env);
  // A coalesced second click must not release the FIRST click's guard.
  const duplicate = handler(f.action, {}, f.env);
  const other = handler({ ...f.action, context: { active_ids: [21], allowed_company_ids: [2] } }, {}, f.env);
  release.resolve();
  await Promise.all([first, duplicate, other]);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0][3].operation_id, f.calls[1][3].operation_id);
});

test("report native fallback is allowed only for explicit no-binding; malformed responses remain intercepted", async () => {
  const { hooks: handler } = await loadHooks("report_interceptor.js");
  const f = reportFixture();
  f.env.services.orm.call = async () => ({ has_binding: false, dispatched: false });
  assert.equal(await handler(f.action, {}, f.env), false);
  f.env.services.orm.call = async () => null;
  assert.equal(await handler(f.action, {}, f.env), true);
  assert.equal(f.notifications.at(-1)[1].type, "danger");
  assert.equal(await handler({ ...f.action, report_type: "qweb-html" }, {}, f.env), false);
});

test("invoice and sales-details submission timeouts preserve identity for a bounded explicit retry", async () => {
  // Accelerate actual deadline timers only; do not mock the deadline helper.
  const options = { setTimeout: (fn) => setTimeout(fn, 2) };
  const { hooks: handler } = await loadHooks("report_interceptor.js", options);
  const f = reportFixture();
  const call = f.env.services.orm.call;
  f.env.services.orm.call = async (...args) => {
    const result = await call(...args);
    if (f.calls.length === 1) return new Promise(() => {});
    return result;
  };
  await handler(f.action, {}, f.env);
  assert.notEqual(f.notifications.at(-1)[1].type, "success");
  await handler(f.action, {}, f.env);
  assert.equal(f.calls[0][3].operation_id, f.calls[1][3].operation_id);

  const { hooks, state } = await loadHooks("pos_sale_details_router.js", options);
  const sale = fixture();
  const saleCall = sale.pos.data.call;
  let actions = 0;
  sale.pos.data.call = async (...args) => {
    const result = await saleCall(...args);
    if (args[1] === "action_print_gateway_sale_details" && ++actions === 1) return new Promise(() => {});
    return result;
  };
  await hooks.onClick.call(sale.button);
  await hooks.onClick.call(sale.button);
  const submissions = submittedCalls(sale);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].kwargs.operation_id, submissions[1].kwargs.operation_id);
  assert.equal(submissions[0].kwargs.image, submissions[1].kwargs.image);
  assert.equal(state.renders, 1);
});
