/** Actual POS routing/recovery modules with isolated Odoo/DOM/HTTP boundaries.
 * A fresh VM models reload before Odoo's debounced IndexedDB write. No native
 * Odoo browser, printer or physical-output evidence is implied by this suite.
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { receiptGeometry } from "./helpers/odoo-printer-geometry.mjs";
import { recoveryIndexedDB } from "./helpers/odoo-recovery-indexeddb.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const change = { new: [{ product_id: 1, quantity: 1, name: "Private customer item" }], cancelled: [], noteUpdate: [] };
const initialPreparation = { lines: {}, metadata: { serverDate: "2026-10-25 00:00:00" } };
// The pinned native pos.order._ensure_to_keep_last_preparation_change rewrites
// metadata.serverDate on ordinary successful sync, even with unchanged lines.
// Native acceptance supplies real registry-generated before/after snapshots;
// standalone execution uses the same documented server transformation.
const nativePreparation = process.env.YASEIR_ODOO_PREPARATION_FIXTURE
  ? JSON.parse(await readFile(process.env.YASEIR_ODOO_PREPARATION_FIXTURE, "utf8"))
  : {
    unknown: { before: clone(initialPreparation), after: { lines: {}, metadata: { serverDate: "2026-10-25 00:00:02" } } },
    accepted: { after: { lines: { line: { quantity: 1 } }, metadata: { serverDate: "2026-10-25 00:00:02" } } },
  };

async function fixture({ storage = new Map(), db = "kitchen_test", sessionId = 5, orderId = 21,
  stations = [1], preparation = initialPreparation, reply, sync, postSync, renderError = false } = {}) {
  class PosStore {
    getOrderData(order, reprint) { return { reprint, orderId: order.id }; }
    generateOrderChange(order, _change, _categories, reprint) { return { orderData: this.getOrderData(order, reprint), changes: _change }; }
    async generateReceiptsDataToPrint(orderData) { return [{ orderData: { ...orderData } }]; }
    async postSyncAllOrders(orders) { return postSync?.(orders); }
  }
  const notifications = [], dialogs = [], submissions = [];
  const mocks = {
    patch(target, extension) {
      const previous = Object.create(Object.getPrototypeOf(target), Object.getOwnPropertyDescriptors(target));
      Object.setPrototypeOf(extension, previous);
      Object.defineProperties(target, Object.getOwnPropertyDescriptors(extension));
    },
    _t: value => value, PosStore, OrderReceipt: class {}, RetryPrintPopup: class {},
    changesToOrder: () => clone(change), renderToElement: () => ({}),
    gatewayServerMessage: error => error?.message, showGatewayBillingLimitDialog: () => false,
    renderGatewayReceiptJpeg: async () => {
      if (renderError) throw new Error("Local renderer failed before dispatch");
      return "PRIVATE-JPEG-PAYLOAD";
    },
  };
  const context = vm.createContext({ console, crypto: webcrypto, setTimeout, clearTimeout, Set, Map, Uint8Array,
    window: { odoo: { __session_info__: { db } }, indexedDB: recoveryIndexedDB(), localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    } },
  });
  const common = new vm.SyntheticModule(Object.keys(mocks), function () {
    for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
  }, { context });
  const root = new URL("../odoo_addons/print_gateway/static/src/js/", import.meta.url);
  const controls = new vm.SourceTextModule(await readFile(new URL("async_control.js", root), "utf8"), { context });
  await controls.link(() => { throw Error("Unexpected control import"); });
  const recovery = new vm.SourceTextModule(await readFile(new URL("operation_recovery.js", root), "utf8"), { context });
  await recovery.link(() => common);
  const addon = new vm.SourceTextModule(await readFile(new URL("pos_print_router.js", root), "utf8"), { context });
  await addon.link(name => name === "./async_control" ? controls : name === "./operation_recovery" ? recovery : common);
  await addon.evaluate();
  const order = { id: orderId, uuid: `order-${orderId}`, isSynced: true, uiState: { lastPrints: [] },
    last_order_preparation_change: clone(preparation),
    updateLastOrderChange() {
      this.last_order_preparation_change = { lines: { line: { quantity: 1 } }, metadata: { serverDate: "2026-10-25 00:00:01" } };
    },
  };
  const pos = new PosStore();
  Object.assign(pos, {
    session: { id: sessionId }, config: { id: 9, printerCategories: new Set([1]) }, company: { id: 3 },
    env: { services: { renderer: {} } }, syncingOrders: new Set(),
    unwatched: { printers: stations.map(id => ({ id, config: { name: `Station ${id}` } })) },
    models: { "product.product": { get: () => ({ parentPosCategIds: [1] }) } },
    notification: { add: (...args) => notifications.push(args) }, dialog: { add: (...args) => dialogs.push(args) },
    updateLastOrderChangeIfNoDevice() {}, displayPrinterWarning() {},
    // Native Odoo calls this hook only with records loaded from a successful
    // sync_from_ui response, before returning the synchronized order array.
    syncAllOrders: async options => {
      const saved = sync ? await sync(options) : [order];
      if (Array.isArray(saved) && saved.length) await pos.postSyncAllOrders(saved);
      return saved;
    },
    data: { call: async (_model, method, _args, kwargs) => {
      if (method === "is_gateway_printing_enabled") return true;
      if (method === "get_gateway_kitchen_routes") return {
        routes: stations.map(id => ({ pos_printer_id: id, category_ids: [1], geometry: receiptGeometry(384) })),
        missing_routes: [],
      };
      assert.equal(method, "action_print_gateway_kitchen");
      submissions.push(kwargs);
      return reply ? reply(kwargs) : { gateway_enabled: true, status: "submitted" };
    } },
  });
  return { pos, order, storage, submissions, notifications, dialogs,
    send: () => pos.sendOrderInPreparation(order), renderWorks: () => { renderError = false; } };
}

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), "Expected asynchronous dispatch boundary was not reached");
}

test("reload after kitchen dispatch but before its response cannot create another operation", async () => {
  const storage = new Map();
  let finish;
  const f = await fixture({ storage, reply: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.send();
  try {
    await until(() => f.submissions.length === 1);
    const reloaded = await fixture({ storage });
    assert.equal(await reloaded.send(), false);
    assert.equal(reloaded.submissions.length, 0, "Lost UI state must not generate a second kitchen UUID");
    assert.equal(storage.size, 1);
    assert.doesNotMatch(JSON.stringify([...storage]), /PRIVATE-JPEG|Private customer item|quantity|product_id/);
  } finally {
    finish({ gateway_enabled: true, status: "unknown" });
    await pending;
  }
});

test("partial station acceptance survives reload without resending either station", async () => {
  const storage = new Map();
  const f = await fixture({ storage, stations: [1, 2], reply: async ({ pos_printer_id }) => {
    if (pos_printer_id === 2) throw Error("Connection lost after dispatch");
    return { gateway_enabled: true, status: "submitted" };
  } });
  assert.equal(await f.send(), false);
  assert.deepEqual(f.submissions.map(item => item.pos_printer_id), [1, 2]);
  const reloaded = await fixture({ storage, stations: [1, 2] });
  assert.equal(await reloaded.send(), false);
  assert.equal(reloaded.submissions.length, 0);
});

test("accepted kitchen batch remains fenced until its consumed preparation state is synchronized", async () => {
  const storage = new Map();
  let synchronize;
  const f = await fixture({ storage, sync: () => new Promise(resolve => { synchronize = resolve; }) });
  const pending = f.send();
  try {
    await until(() => Boolean(synchronize));
    const reloaded = await fixture({ storage }); // server still has the old preparation state
    assert.equal(await reloaded.send(), false);
    assert.equal(reloaded.submissions.length, 0);
    assert.equal(storage.size, 1);
  } finally {
    synchronize([f.order]);
    await pending;
  }
  assert.equal(storage.size, 0, "Confirmed preparation synchronization resolves the fence");
  const next = await fixture({ storage, preparation: f.order.last_order_preparation_change });
  assert.equal(await next.send(), true);
  assert.equal(next.submissions.length, 1);
});

for (const result of [undefined, [], new Error("Odoo returned an offline error")]) {
  test(`non-confirming Odoo synchronization cannot clear an accepted batch (${String(result)})`, async () => {
    const storage = new Map();
    const f = await fixture({ storage, sync: async () => result });
    assert.equal(await f.send(), true, "Printer acceptance and preparation synchronization are distinct");
    const reloaded = await fixture({ storage });
    assert.equal(await reloaded.send(), false);
    assert.equal(reloaded.submissions.length, 0);
  });
}

test("definite pre-output failure releases the fence and an authorized retry can proceed", async () => {
  const storage = new Map();
  const f = await fixture({ storage, renderError: true });
  assert.equal(await f.send(), false);
  assert.equal(f.submissions.length, 0);
  assert.equal(storage.size, 0);
  f.renderWorks();
  assert.equal(await f.dialogs[0][1].retry(), true);
  assert.equal(f.submissions.length, 1);
  assert.equal(storage.size, 0);
});

test("recovery is scoped by database, session and order without merging other print intents", async () => {
  const storage = new Map();
  const first = await fixture({ storage, reply: async () => ({ gateway_enabled: true, status: "unknown" }) });
  assert.equal(await first.send(), false);
  assert.equal(storage.size, 1);
  for (const scope of [{ db: "another_database" }, { sessionId: 6 }, { orderId: 22 }]) {
    const other = await fixture({ storage, ...scope });
    assert.equal(await other.send(), true);
    assert.equal(other.submissions.length, 1);
  }
  assert.equal(storage.size, 1, "Only the original uncertain operation remains unresolved");
});

test("canonical preparation state survives key reordering after server serialization", async () => {
  const storage = new Map();
  const first = await fixture({ storage, reply: async () => ({ gateway_enabled: true, status: "unknown" }) });
  assert.equal(await first.send(), false);
  const reloaded = await fixture({ storage, preparation: { metadata: clone(initialPreparation.metadata), lines: {} } });
  assert.equal(await reloaded.send(), false);
  assert.equal(reloaded.submissions.length, 0);
});

test("live partial retry sends only the definitely rejected station and resolves after synchronization", async () => {
  const storage = new Map();
  let rejectSecond = true;
  const f = await fixture({ storage, stations: [1, 2], reply: async ({ pos_printer_id }) => ({
    gateway_enabled: true, status: rejectSecond && pos_printer_id === 2 ? "failed" : "submitted", can_retry: true,
  }) });
  assert.equal(await f.send(), false);
  assert.equal(storage.size, 1, "Already accepted first station must remain fenced");
  rejectSecond = false;
  assert.equal(await f.dialogs[0][1].retry(), true);
  assert.deepEqual(f.submissions.map(item => item.pos_printer_id), [1, 2, 2]);
  assert.notEqual(f.submissions[1].operation_id, f.submissions[2].operation_id,
    "Explicit retry follows a definite rejection, preserving existing operation semantics");
  assert.equal(storage.size, 0);
});

test("changed live order data cannot reopen an uncertain preparation batch", async () => {
  const f = await fixture({ reply: async () => ({ gateway_enabled: true, status: "unknown" }) });
  assert.equal(await f.send(), false);
  const modified = clone(change);
  modified.new[0].quantity = 2;
  assert.equal(await f.pos.printChanges(f.order, [modified]), false);
  assert.equal(f.submissions.length, 1);
});

test("unavailable recovery storage stops before any kitchen submission", async () => {
  class DeniedStorage extends Map { set() { throw Error("Browser storage unavailable"); } }
  const f = await fixture({ storage: new DeniedStorage() });
  assert.equal(await f.send(), false);
  assert.equal(f.submissions.length, 0);
  assert.ok(f.notifications.length);
});

test("explicit accepted reprints resolve their fence, but an uncertain reprint survives reload", async () => {
  const storage = new Map();
  const accepted = await fixture({ storage });
  assert.equal(await accepted.pos.printChanges(accepted.order, [clone(change)], true), true);
  assert.equal(storage.size, 0, "An explicit accepted reprint has no new preparation change to synchronize");
  const uncertain = await fixture({ storage, reply: async () => ({ gateway_enabled: true, status: "unknown" }) });
  assert.equal(await uncertain.pos.printChanges(uncertain.order, [clone(change)], true), false);
  const reloaded = await fixture({ storage });
  assert.equal(await reloaded.pos.printChanges(reloaded.order, [clone(change)], true), false);
  assert.equal(reloaded.submissions.length, 0);
  assert.equal(storage.size, 1);
});

test("a sync response for stale preparation state or another order cannot close the fence", async () => {
  for (const mismatch of ["state", "order"]) {
    const storage = new Map();
    const f = await fixture({ storage, sync: async ({ orders: [order] }) => [{
      ...order,
      id: mismatch === "order" ? 999 : order.id,
      last_order_preparation_change: mismatch === "state" ? initialPreparation : order.last_order_preparation_change,
    }] });
    assert.equal(await f.send(), true);
    assert.equal(storage.size, 1);
  }
});

test("preparation-display synchronization releases only an acknowledged accepted batch", async () => {
  const f = await fixture();
  f.pos.models["pos.prep.display"] = [{}];
  assert.equal(await f.send(), true);
  assert.equal(f.storage.size, 1, "Preparation display has not synchronized the consumed state yet");
  await f.pos.syncAllOrders({ orders: [f.order] });
  assert.equal(f.storage.size, 0, "Later acknowledged preparation-display synchronization resolves the fence");

  for (const stations of [[1], [1, 2]]) {
    const unresolved = await fixture({ stations, reply: async ({ pos_printer_id }) => ({
      gateway_enabled: true, status: pos_printer_id === stations.at(-1) ? "unknown" : "submitted",
    }) });
    unresolved.pos.models["pos.prep.display"] = [{}];
    assert.equal(await unresolved.send(), false);
    await unresolved.pos.syncAllOrders({ orders: [unresolved.order] });
    assert.equal(unresolved.storage.size, 1, "Synchronization cannot confirm unknown or partial printing");
  }
});

test("later sync waits for the native hook and cannot replace server proof with mutated local state", async () => {
  let finish;
  const f = await fixture({ postSync: () => new Promise(resolve => { finish = resolve; }) });
  f.pos.models["pos.prep.display"] = [{}];
  assert.equal(await f.send(), true);
  const pending = f.pos.syncAllOrders({ orders: [f.order] });
  await until(() => Boolean(finish));
  assert.equal(f.storage.size, 1, "The native synchronization hook still owns its work");
  finish();
  await pending;
  assert.equal(f.storage.size, 0);

  const stale = await fixture({ postSync: orders => {
    // A downstream hook may update the local record. Only the preparation
    // state acknowledged on entry to postSyncAllOrders is server evidence.
    orders[0].last_order_preparation_change = clone(stale.order.last_order_preparation_change);
  } });
  stale.pos.models["pos.prep.display"] = [{}];
  assert.equal(await stale.send(), true);
  await stale.pos.postSyncAllOrders([{ ...stale.order, last_order_preparation_change: clone(initialPreparation) }]);
  assert.equal(stale.storage.size, 1);
});

test("the full send path cannot trust returned models mutated after server acknowledgement", async () => {
  const storage = new Map();
  const f = await fixture({ storage,
    sync: async ({ orders: [order] }) => [{ ...order, last_order_preparation_change: clone(initialPreparation) }],
    postSync: orders => { orders[0].last_order_preparation_change = clone(f.order.last_order_preparation_change); },
  });
  assert.equal(await f.send(), true);
  const reloaded = await fixture({ storage });
  assert.equal(await reloaded.send(), false);
  assert.equal(reloaded.submissions.length, 0, "Mutated local records do not prove that the server saved consumed preparation");
  assert.equal(storage.size, 1);
});

for (const stations of [[1], [1, 2]]) {
  test(`native server timestamp rebasing cannot reopen an uncertain kitchen batch (${stations.length} stations)`, async () => {
    const storage = new Map();
    const f = await fixture({ storage, stations, preparation: nativePreparation.unknown.before,
      reply: async ({ pos_printer_id }) => ({ gateway_enabled: true,
        status: pos_printer_id === stations.at(-1) ? "unknown" : "submitted" }),
      sync: async ({ orders: [order] }) => {
        order.last_order_preparation_change = clone(nativePreparation.unknown.after);
        return [order];
      },
    });
    assert.equal(await f.send(), false);
    const reloaded = await fixture({ storage, stations, preparation: nativePreparation.unknown.after });
    assert.equal(await reloaded.send(), false);
    assert.equal(reloaded.submissions.length, 0, "The native server only rebased a timestamp; the uncertain print intent is unchanged");
    assert.equal(storage.size, 1);
  });
}

test("native server timestamp rebasing still confirms the same accepted preparation content", async () => {
  const f = await fixture({ sync: async ({ orders: [order] }) => {
    order.last_order_preparation_change = clone(nativePreparation.accepted.after);
    return [order];
  } });
  assert.equal(await f.send(), true);
  assert.equal(f.storage.size, 0, "Server bookkeeping timestamps do not make matching consumed lines unrecognizable");
});
