import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Production Odoo addon hooks, with only Odoo RPC, browser storage, DOM raster
// and controller installation replaced. A new VM means a page reload.
function createStorage() {
    const records = new Map();
    return {
        records,
        getItem: (key) => records.has(key) ? records.get(key) : null,
        setItem: (key, value) => { records.set(key, String(value)); },
        removeItem: (key) => records.delete(key),
    };
}
const root = new URL('../odoo_addons/print_gateway/static/src/js/', import.meta.url);

async function loadHook(file, { storage, clock = { now: 1000 }, storageThrows = false, infoThrows = false } = {}) {
    let hook;
    const f = {
        calls: [], notices: [], renders: 0,
        order: { id: 221, uuid: '221-uuid', isSynced: true, nb_print: 0 },
    };
    f.pos = {
        session: { id: 11 }, config: { id: 17 }, company: { id: 3 },
        env: { services: { user: { userId: 29 }, company: { currentCompany: { id: 3 } },
            renderer: { toHtml: async () => ({}) } }, utils: { formatCurrency: () => '3' } },
        notification: { add: (...args) => f.notices.push(args) },
        getOrder: () => f.order, syncAllOrders: async () => {},
        data: { call: async (...args) => {
            f.calls.push(args);
            const method = args[1];
            if (method === 'is_gateway_printing_enabled') return true;
            if (method.endsWith('raster_width')) return 384;
            if (method === 'get_sale_details') return {};
            if (f.onSubmit) return f.onSubmit(...args);
            return { gateway_enabled: true, status: 'submitted', dispatched: true };
        }, silentCall: async () => true },
    };
    f.button = { pos: f.pos, env: { services: { notification: f.pos.notification, renderer: f.pos.env.services.renderer } } };
    f.env = { services: {
        orm: { call: async (...args) => {
            f.calls.push(args);
            if (f.onSubmit) return f.onSubmit(...args);
            return { has_binding: true, dispatched: true, success: true, status: 'submitted' };
        } },
        user: { userId: 29 }, company: { currentCompany: { id: 3 } },
        notification: { add: (...args) => f.notices.push(args) },
        action: { doAction() {} },
    } };
    f.action = {
        type: 'ir.actions.report', report_type: 'qweb-pdf', id: 41,
        report_name: 'account.report_invoice', context: { allowed_company_ids: [3], active_ids: [221] },
    };
    const native = {
        printReceipt: async () => true, onClick: async () => true,
    };
    const mocks = {
        patch: (_proto, impl) => { Object.setPrototypeOf(impl, native); hook = impl; },
        _t: (phrase, ...args) => { let n = 0; return phrase.replace(/%s/g, () => String(args[n++])); },
        registry: { category: () => ({ add: (_name, handler) => { hook = handler; } }) },
        PosStore: class {}, SaleDetailsButton: class {}, OrderReceipt: { template: 'receipt' },
        RetryPrintPopup: class {}, changesToOrder: () => ({}),
        renderToElement: () => ({}), formatDateTime: () => 'now',
        gatewayServerMessage: error => error?.message,
        showGatewayBillingLimitDialog: () => false,
    };
    const DateStub = class extends Date { static now() { return clock.now; } };
    const localWindow = storageThrows
        ? Object.defineProperty({}, 'localStorage', { get() { throw new Error('Storage blocked'); } })
        : { localStorage: storage, location: { search: '?db=yaseir-audit', pathname: '/pos/ui' } };
    const context = vm.createContext({
        console: { warn() {}, error() {}, log() {}, ...(infoThrows ? { info() { throw new Error('console sink failed'); } } : {}) }, Date: DateStub,
        crypto: webcrypto, Map, Set, Uint8Array, window: localWindow,
        luxon: { DateTime: { now: () => ({}) } },
        setTimeout, clearTimeout,
    });
    const common = new vm.SyntheticModule(Object.keys(mocks), function () {
        for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
    }, { context });
    const raster = new vm.SyntheticModule(['DEFAULT_RECEIPT_RASTER_WIDTH', 'normalizedReceiptRasterWidth', 'renderGatewayReceiptJpeg'], function () {
        this.setExport('DEFAULT_RECEIPT_RASTER_WIDTH', 512);
        this.setExport('normalizedReceiptRasterWidth', val => Number(val) || 512);
        this.setExport('renderGatewayReceiptJpeg', async () => `JPEG-SNAPSHOT-${++f.renders}`);
    }, { context });
    const asyncModule = new vm.SourceTextModule(await readFile(new URL('async_control.js', root), 'utf8'), { context });
    const recoveryModule = new vm.SourceTextModule(await readFile(new URL('operation_recovery.js', root), 'utf8').catch(() => 'export const notImplemented = true;'), { context });
    await Promise.all([asyncModule.link(() => { throw Error('Unexpected import'); }), recoveryModule.link(() => { throw Error('Unexpected import'); })]);
    const addon = new vm.SourceTextModule(await readFile(new URL(file, root), 'utf8'), { context });
    await addon.link(name => name === './receipt_raster' ? raster : name === './async_control' ? asyncModule : name === './operation_recovery' ? recoveryModule : common);
    await addon.evaluate();
    return { hook, f };
}
const submitCalls = f => f.calls.filter(args => /^action_print_gateway_/.test(args[1]) || args[1] === 'dispatch_report_action');

for (const [file, label, invoke] of [
    ['pos_print_router.js', 'receipt', ({hook, f}) => hook.printReceipt.call(f.pos)],
    ['pos_sale_details_router.js', 'sale details', ({hook, f}) => hook.onClick.call(f.button)],
    ['report_interceptor.js', 'report', ({hook, f}) => hook(f.action, {}, f.env)],
]) {
    test(`${label}: lost response retains original operation identity after five-minute interval`, async () => {
        const storage = createStorage(), clock = {now: 1_000};
        const current = await loadHook(file, { storage, clock });
        let attempts = 0;
        current.f.onSubmit = () => { if (++attempts === 1) throw new Error('Reply lost after commit'); return { gateway_enabled: true, has_binding: true, dispatched: true, success: true, status: 'submitted' }; };
        await invoke(current);
        clock.now += 12 * 60 * 1000;
        await invoke(current);
        const calls = submitCalls(current.f);
        assert.equal(calls.length, 2, 'real safe replay should occur from available in-memory payload');
        const key = 3;
        assert.equal(calls[0][key].operation_id, calls[1][key].operation_id);
        if (file !== 'report_interceptor.js') {
            assert.equal(calls[0][3].image, calls[1][3].image);
            assert.equal(current.f.renders, 1);
        }
    });
    test(`${label}: reload after uncertain result must not issue a fresh print from missing payload`, async () => {
        const storage = createStorage(), clock = {now: 1_000};
        const old = await loadHook(file, { storage, clock });
        old.f.onSubmit = () => { throw new Error('Reply lost after commit'); };
        await invoke(old);
        assert.equal(submitCalls(old.f).length, 1);
        const reloaded = await loadHook(file, { storage, clock: { now: 25 * 60 * 1000 } });
        await invoke(reloaded);
        assert.equal(submitCalls(reloaded.f).length, 0, 'cannot safely replay after reload without original evidence');
        assert.ok(reloaded.f.notices.some(([text, meta]) => meta?.sticky && meta.type === 'warning' && /Print Activity|print job/i.test(text)));
    });
}

test('receipt: blocked browser storage fails closed before any print dispatch', async () => {
    const current = await loadHook('pos_print_router.js', {storageThrows:true});
    await current.hook.printReceipt.call(current.f.pos);
    assert.equal(submitCalls(current.f).length, 0);
    assert.ok(current.f.notices.length > 0);
});

test('receipt: missing or throwing optional performance logger cannot cancel dispatch', async () => {
    for (const infoThrows of [false, true]) {
        const current = await loadHook('pos_print_router.js', { storage: createStorage(), infoThrows });
        await current.hook.printReceipt.call(current.f.pos);
        assert.equal(submitCalls(current.f).length, 1, 'POS must submit once despite failed diagnostic logging');
        assert.equal(current.f.renders, 1, 'receipt must retain the exact captured JPEG snapshot');
    }
});
