import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

// Native rendering/generation, ORM RPC and synchronization are the external
// boundaries. The addon orchestration, operation maps, station dispatch and
// deadline implementation are loaded unchanged from production source.
async function fixture({ draft = false, enabled = true, holdStage = null,
    delaySecondMetadata = false, failStage = null, stationOutcome = "submitted" } = {}) {
    let hooks, recovered = false, held = false, activationCalls = 0, metadataCalls = 0;
    const reached = deferred(), released = deferred();
    const submissions = [], notifications = [], dialogs = [], syncs = [], nativeCalls = [];
    async function stage(name) {
        if (failStage === name && !recovered) throw new Error(`${name} unavailable`);
        if (holdStage === name && !held) {
            held = true;
            reached.resolve();
            await released.promise;
        }
    }
    class NativeStore {
        getOrderData(order, reprint) { return { order_id: order.id, reprint }; }
        generateOrderChange(order, change, _categories, reprint) { return { orderData: this.getOrderData(order, reprint), changes: change }; }
        async generateReceiptsDataToPrint(orderData, changes) { return [{ orderData, changes }]; }
        async sendOrderInPreparation(order) {
            nativeCalls.push("preparation");
            return this.printChanges(order, []);
        }
        async printChanges() {
            nativeCalls.push("changes");
            return (await this.printOrderChanges({ orderData: { __gateway_session_id: 5 } })).successful;
        }
        async printOrderChanges() { nativeCalls.push("station"); return { successful: true }; }
    }
    const mocks = {
        patch: (_prototype, extension) => {
            hooks = extension;
            Object.setPrototypeOf(hooks, NativeStore.prototype);
        },
        _t: (message, ...args) => args.reduce((text, arg) => text.replace("%s", arg), message),
        PosStore: NativeStore, OrderReceipt: class {}, RetryPrintPopup: class {},
        changesToOrder: (order) => order.consumed
            ? { new: [], cancelled: [], noteUpdate: [] }
            : { new: [{ product_id: 1, quantity: 1 }], cancelled: [], noteUpdate: [] },
        renderToElement: (_name, value) => value,
        gatewayServerMessage: (error) => error?.data?.message || error?.message,
        showGatewayBillingLimitDialog: () => false,
        DEFAULT_RECEIPT_RASTER_WIDTH: 512,
        normalizedReceiptRasterWidth: (value) => value,
        renderGatewayReceiptJpeg: async (_receipt, { width }) => {
            await stage("render");
            return `JPEG_${width}`;
        },
    };
    const context = vm.createContext({ console, crypto: webcrypto, Set, Map, Uint8Array, setTimeout, clearTimeout });
    const common = new vm.SyntheticModule(Object.keys(mocks), function () {
        for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
    }, { context });
    const root = new URL("../odoo_addons/print_gateway/static/src/js/", import.meta.url);
    const controls = new vm.SourceTextModule(await readFile(new URL("async_control.js", root), "utf8"), { context });
    await controls.link(() => { throw new Error("Unexpected import"); });
    const recovery = new vm.SourceTextModule(await readFile(new URL("operation_recovery.js", root), "utf8"), { context });
    await recovery.link(() => { throw new Error("Unexpected recovery import"); });
    const addon = new vm.SourceTextModule(await readFile(new URL("pos_print_router.js", root), "utf8"), { context });
    await addon.link((name) => name === "./async_control" ? controls : name === "./operation_recovery" ? recovery : common);
    await addon.evaluate();
    const printers = [1, 2].map((id) => ({ id, config: { name: `Station ${id}` } }));
    const order = { id: draft ? "new-order" : 21, uuid: "order-21", isSynced: !draft,
        isDirty: () => true, uiState: { lastPrints: [] },
        updateLastOrderChange() { this.consumed = (this.consumed || 0) + 1; } };
    const pos = {
        session: { id: 5 }, config: { printerCategories: new Set([1]) },
        unwatched: { printers }, syncingOrders: new Set(), models: {}, env: { services: { renderer: {} } },
        notification: { add: (...args) => notifications.push(args) },
        dialog: { add: (...args) => dialogs.push(args) }, displayPrinterWarning() {},
        updateLastOrderChangeIfNoDevice() { pos.nativeChangeUpdates = (pos.nativeChangeUpdates || 0) + 1; },
        data: { call: async (_model, method, _args, kwargs) => {
            if (method === "is_gateway_printing_enabled") {
                activationCalls++;
                await stage("activation");
                return enabled;
            }
            if (method === "get_gateway_kitchen_routes") {
                metadataCalls++;
                if (delaySecondMetadata && metadataCalls === 2) await released.promise;
                await stage("metadata");
                return { routes: printers.map((p) => ({ pos_printer_id: p.id,
                    category_ids: [1], raster_width: p.id === 1 ? 384 : 576 })), missing_routes: [] };
            }
            assert.equal(method, "action_print_gateway_kitchen");
            submissions.push({ station: kwargs.pos_printer_id, operation: kwargs.operation_id, image: kwargs.image, reprint: kwargs.reprint });
            await stage("submission");
            if (kwargs.pos_printer_id === 2 && !recovered) {
                if (stationOutcome === "lost-response") throw new Error("Response lost after dispatch");
                if (stationOutcome === "malformed") return {};
                if (stationOutcome === "unexpected") return { status: "future-status" };
                if (stationOutcome === "unknown" || stationOutcome === "partial") return { status: stationOutcome, can_retry: true };
                if (stationOutcome === "failed") return { status: "failed", can_retry: true,
                    message: "The printer refused this operation before admission." };
            }
            return { status: "submitted", can_retry: false };
        } },
        syncAllOrders: async (options = {}) => {
            await stage(options.force ? "firstSync" : "finalSync");
            for (const candidate of options.orders.filter((value) => !pos.syncingOrders.has(value.uuid))) {
                syncs.push({ id: candidate.id, consumed: candidate.consumed || 0 });
                candidate.id = 21;
                candidate.isSynced = true;
            }
        },
    };
    for (const name of ["getOrderData", "generateOrderChange", "generateReceiptsDataToPrint", "printChanges", "printOrderChanges"])
        pos[name] = (...args) => hooks[name].call(pos, ...args);
    return { hooks, pos, order, submissions, notifications, dialogs, syncs, nativeCalls,
        reached: reached.promise, release: released.resolve,
        recover: () => { recovered = true; },
        metadataCalls: () => metadataCalls, activationCalls: () => activationCalls };
}

test("a metadata response after the first kitchen batch finishes cannot create four operations for two stations", async () => {
    const f = await fixture({ delaySecondMetadata: true });
    const first = f.hooks.sendOrderInPreparation.call(f.pos, f.order);
    const second = f.hooks.sendOrderInPreparation.call(f.pos, f.order);
    assert.equal(await first, true);
    f.release();
    assert.equal(await second, false);
    assert.equal(f.metadataCalls(), 1);
    assert.equal(new Set(f.submissions.map((s) => `${s.station}:${s.operation}`)).size, 2);
    assert.equal(f.order.consumed, 1);
    assert.deepEqual(f.submissions.map((s) => s.image), ["JPEG_384", "JPEG_576"]);
});

for (const stage of ["activation", "firstSync", "metadata", "render", "submission", "finalSync"]) {
    test(`per-order kitchen owner spans ${stage} and direct printChanges callers`, async () => {
        const f = await fixture({ draft: stage === "firstSync", holdStage: stage });
        const first = f.hooks.sendOrderInPreparation.call(f.pos, f.order);
        await f.reached;
        const duplicate = f.pos.printChanges(f.order, [{ new: [{ product_id: 1, quantity: 1 }] }]);
        const duplicateResult = await duplicate;
        f.release();
        assert.equal(await first, true);
        assert.equal(duplicateResult, false);
        assert.equal(f.submissions.length, 2);
        assert.equal(f.order.consumed, 1);
        assert.equal(f.pos.syncingOrders.size, 0);
    });
}

for (const stage of ["activation", "firstSync", "metadata", "render"]) {
    test(`kitchen owner releases after ${stage} failure`, async () => {
        const f = await fixture({ draft: stage === "firstSync", failStage: stage });
        assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), false);
        assert.equal(f.submissions.length, 0);
        f.recover();
        assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), true);
        assert.equal(f.submissions.length, 2);
        assert.equal(f.order.consumed, 1);
        assert.equal(f.pos.syncingOrders.size, 0);
    });
}

test("definite station refusal exposes its reason and concurrent retry callbacks preserve accepted stations", async () => {
    const f = await fixture({ stationOutcome: "failed" });
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), false);
    assert.equal(f.order.consumed, undefined);
    assert.equal(f.dialogs.length, 1);
    assert.match(f.dialogs[0][1].message, /refused this operation/);
    const previous = f.submissions[1].operation;
    f.recover();
    const retry = f.dialogs[0][1].retry;
    const results = await Promise.all([retry(), retry()]);
    assert.deepEqual(results, [true, false]);
    assert.deepEqual(f.submissions.map((s) => s.station), [1, 2, 2]);
    assert.notEqual(f.submissions[2].operation, previous);
    assert.equal(f.order.consumed, 1);
    assert.equal(f.order.uiState.lastPrints.length, 1);
    assert.equal(f.syncs.at(-1).consumed, 1);
});

for (const outcome of ["unknown", "partial", "lost-response", "malformed", "unexpected"]) {
    test(`${outcome} station outcome suppresses retry and preserves accepted subset and identity`, async () => {
        const f = await fixture({ stationOutcome: outcome });
        assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), false);
        const stationAttempt = Object.entries(f.order.uiState.gatewayKitchenAttempts).find(([key]) => key.startsWith("2:"))[1];
        assert.equal(stationAttempt.gatewayOutcome, outcome === "partial" ? "partial" : "unknown");
        assert.equal(stationAttempt.canRetry, false);
        assert.equal(f.dialogs.length, 0);
        assert.equal(f.order.consumed, undefined);
        f.recover();
        assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), false);
        assert.equal(f.submissions.length, 2);
        assert.equal(f.order.consumed, undefined);
    });
}

test("accepted kitchen retry retains ownership until post-print synchronization settles", async () => {
    const f = await fixture({ stationOutcome: "failed", holdStage: "finalSync" });
    const first = f.hooks.sendOrderInPreparation.call(f.pos, f.order);
    await f.reached;
    const overlapping = f.dialogs[0][1].retry();
    assert.equal(await overlapping, false);
    f.release();
    assert.equal(await first, false);
    f.recover();
    assert.equal(await f.dialogs[0][1].retry(), true);
    assert.equal(f.order.consumed, 1);
    assert.equal(f.submissions.length, 3);
});

test("post-print sync failure retains acceptance, reports a warning and releases kitchen ownership", async () => {
    const f = await fixture({ failStage: "finalSync" });
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), true);
    assert.equal(f.order.consumed, 1);
    assert.equal(f.submissions.length, 2);
    assert.ok(f.notifications.some(([, options]) => options.type === "warning"));
    f.recover();
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), false);
    assert.equal(f.submissions.length, 2);
    assert.equal(f.pos.syncingOrders.size, 0);
});

test("disabled Gateway keeps native preparation and direct changes behavior", async () => {
    const f = await fixture({ enabled: false });
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), true);
    assert.equal(await f.pos.printChanges(f.order, []), true);
    assert.deepEqual(f.nativeCalls, ["preparation", "changes", "station", "changes", "station"]);
    assert.equal(f.submissions.length, 0);
});

test("preparation-display bypass preserves native change update without a first-save or print", async () => {
    const f = await fixture({ draft: true, failStage: "firstSync" });
    f.pos.models["pos.prep.display"] = [{}];
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order, { byPassPrint: true }), false);
    assert.equal(f.pos.nativeChangeUpdates, 1);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.syncs.length, 0);
});


test("explicit last-ticket reprint creates new operations after accepted preparation", async () => {
    const f = await fixture();
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order), true);
    const original = new Set(f.submissions.map((s) => s.operation));
    assert.equal(await f.hooks.sendOrderInPreparation.call(f.pos, f.order, { explicitReprint: true }), true);
    assert.deepEqual(f.submissions.map((s) => s.station), [1, 2, 1, 2]);
    assert.ok(f.submissions.slice(2).every((s) => s.reprint && !original.has(s.operation)));
});
