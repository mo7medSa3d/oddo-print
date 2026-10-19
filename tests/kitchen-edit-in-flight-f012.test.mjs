import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto, createHash } from "node:crypto";
import vm from "node:vm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Optional explicit source tree path permits running against different snapshots.
const repo = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]) + "/")
    : new URL("../", import.meta.url);
const nativeOrderPath = new URL("./fixtures/odoo19-native-update-last-order-change.txt", import.meta.url);
const nativeOrderSource = await readFile(nativeOrderPath, "utf8");
const nativeMethod = nativeOrderSource.slice(nativeOrderSource.indexOf("    updateLastOrderChange() {"));
assert.ok(nativeMethod.includes("updateLastOrderChange()"));
const nativeChangeSource = await readFile(new URL("./fixtures/odoo19-native-order-change.mjs", import.meta.url), "utf8");
const addonSource = await readFile(new URL("odoo_addons/print_gateway/static/src/js/pos_print_router.js", repo), "utf8");
let hooks, signalSubmitted, releaseSubmitted;
const submitted = new Promise((resolve) => { signalSubmitted = resolve; });
const released = new Promise((resolve) => { releaseSubmitted = resolve; });
class NativeStore {
    getOrderData(order, reprint) { return { order_id: order.id, reprint }; }
    generateOrderChange(order, change, _categories, reprint) {
        return { orderData: this.getOrderData(order, reprint), changes: change };
    }
    async generateReceiptsDataToPrint(orderData, changes) { return [{ orderData, changes }]; }
}
const context = vm.createContext({ console, crypto: webcrypto, Set, Map, Uint8Array, setTimeout, clearTimeout,
    deserializeDateTime: () => ({ isValid: false }), serializeDateTime: () => "2026-10-09T00:00:00Z",
    DateTime: { now: () => ({}) } });
const nativeChange = new vm.SourceTextModule(nativeChangeSource, { context });
await nativeChange.link(() => { throw new Error("Unexpected native import"); });
await nativeChange.evaluate();
const printed = [];
const mocks = {
    patch: (_prototype, extension) => { hooks = extension; Object.setPrototypeOf(hooks, NativeStore.prototype); },
    _t: (message) => message, PosStore: NativeStore, OrderReceipt: class {}, RetryPrintPopup: class {},
    changesToOrder: nativeChange.namespace.changesToOrder,
    renderToElement: (_name, value) => value,
    gatewayServerMessage: (error) => error?.message, showGatewayBillingLimitDialog: () => false,
    DEFAULT_RECEIPT_RASTER_WIDTH: 512, normalizedReceiptRasterWidth: (value) => value,
    renderGatewayReceiptJpeg: async (element) => {
        printed.push(JSON.parse(JSON.stringify(element.data.changes)));
        return "JPEG_SNAPSHOT_ONE";
    },
};
const common = new vm.SyntheticModule(Object.keys(mocks), function () {
    for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
}, { context });
const controls = new vm.SourceTextModule(await readFile(new URL("odoo_addons/print_gateway/static/src/js/async_control.js", repo), "utf8"), { context });
await controls.link(() => { throw new Error("Unexpected import"); });
const recovery = new vm.SourceTextModule(await readFile(new URL("odoo_addons/print_gateway/static/src/js/operation_recovery.js", repo), "utf8"), { context });
await recovery.link(() => { throw new Error("Unexpected recovery import"); });
const addon = new vm.SourceTextModule(addonSource, { context });
await addon.link((name) => name === "./async_control" ? controls : name === "./operation_recovery" ? recovery : common);
await addon.evaluate();
const product = { id: 1, name: "Meal", display_name: "Meal", parentPosCategIds: [1], pos_categ_ids: [{ id: 1, sequence: 1 }] };
const line = { uuid: "line-1", preparationKey: "line-1", product_id: product, qty: 1, note: "", customer_note: "",
    attribute_value_ids: [], combo_line_ids: [], uiState: {},
    getQuantity() { return this.qty; }, getNote() { return this.note; }, getCustomerNote() { return this.customer_note; },
    getProduct() { return this.product_id; }, getFullProductName() { return "Meal"; },
    setHasChange(value) { this.hasChange = value; } };
const order = { id: 21, uuid: "order-21", isSynced: true, lines: [line], uiState: { lastPrints: [] },
    general_customer_note: "", internal_note: "", preset_id: { id: 1 },
    last_order_preparation_change: { lines: {}, general_customer_note: "", internal_note: "", metadata: {} },
    getOrderlines() { return this.lines; }, _markDirty() { this.dirty = true; },
    models: { "pos.order.line": { getBy: (_field, uuid) => uuid === line.uuid ? line : undefined } } };
order.updateLastOrderChange = vm.runInContext("({" + nativeMethod + "})", context).updateLastOrderChange;
const station = { id: 1, config: { name: "Kitchen" } };
const pos = { session: { id: 5 }, config: { printerCategories: new Set([1]) },
    unwatched: { printers: [station] }, syncingOrders: new Set(), models: {}, env: { services: { renderer: {} } },
    notification: { add() {} }, dialog: { add() {} }, displayPrinterWarning() {},
    updateLastOrderChangeIfNoDevice() {}, syncAllOrders: async () => {},
    data: { call: async (_model, method) => {
        if (method === "is_gateway_printing_enabled") return true;
        if (method === "get_gateway_kitchen_routes") return { routes: [{ pos_printer_id: 1, category_ids: [1], raster_width: 384 }], missing_routes: [] };
        assert.equal(method, "action_print_gateway_kitchen");
        signalSubmitted();
        await released;
        return { gateway_enabled: true, status: "submitted", can_retry: false };
    } } };
for (const [name, method] of Object.entries(hooks)) if (typeof method === "function") pos[name] = (...args) => method.call(pos, ...args);
const first = pos.sendOrderInPreparation(order);
await submitted;
line.qty = 2;
line.note = "No salt added while dispatch was pending";
order.internal_note = "New instruction entered after the ticket snapshot";
releaseSubmitted();
assert.equal(await first, true);
const remaining = nativeChange.namespace.changesToOrder(order, pos.config.printerCategories);
const result = { printedSnapshot: printed[0], currentQuantity: line.qty,
    consumedQuantity: order.last_order_preparation_change.lines[line.preparationKey].quantity,
    consumedLineNote: order.last_order_preparation_change.lines[line.preparationKey].note,
    consumedOrderNote: order.last_order_preparation_change.internal_note,
    nativeRemainingChanges: remaining,
    expectedRemainingQuantity: line.qty - printed[0].new[0].quantity,
    sourceHashes: { addon: createHash("sha256").update(addonSource).digest("hex"),
        nativeOrder: createHash("sha256").update(nativeOrderSource).digest("hex"),
        nativeChanges: createHash("sha256").update(nativeChangeSource).digest("hex") },
    boundaries: ["native line getters/preparationKey adapter", "native receipt generation adapter", "DOM/JPEG encoder", "RPC and post-print synchronization", "date serialization/clock"] };
console.log(JSON.stringify(result, null, 2));
assert.equal(result.printedSnapshot.new[0].quantity, 1);
assert.equal(result.consumedQuantity, 1, "accounting must consume the captured ticket, not later live edits");
assert.equal(result.expectedRemainingQuantity, 1);
assert.equal(result.nativeRemainingChanges.new[0].quantity, 1, "native delta retains the extra quantity");
assert.equal(result.nativeRemainingChanges.noteUpdate.length, 1, "native delta retains the edited line note");
assert.equal(result.nativeRemainingChanges.internal_note, order.internal_note, "native delta retains the edited order note");
assert.equal(await pos.sendOrderInPreparation(order), true, "second dispatch submits only the remaining change");
assert.equal(printed.length, 2);
assert.equal(printed[1].new[0].quantity, 1);
assert.equal(order.last_order_preparation_change.lines[line.preparationKey].quantity, 2);
