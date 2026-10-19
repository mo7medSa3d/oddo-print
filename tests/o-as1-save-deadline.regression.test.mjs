import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Real patched Odoo Record/FormController methods; ORM, timer and navigation
// services are deterministic stand-ins for Odoo 19 browser edges.
async function setup({ rpc = 'settles', load = 'settles', native = 'settles' } = {}) {
    const events = [], notifications = [], pending = [];
    let controller;
    class FormController { async onRecordSaved() {} }
    class Record {
        constructor() { this.resModel='print_gateway.gateway_config'; this.resId=7; this.data={gateway_api_key:'old'}; }
        async _save() {
            if (native === 'reject') throw new Error('Core web_save rejected');
            await controller.onRecordSaved(this, {gateway_api_key:'new'});
            events.push('native-saved');
            this.data={gateway_api_key:'new',gateway_sync_state:'pending'};
            return true;
        }
    }
    const patch=(proto, ext) => {
        Object.setPrototypeOf(ext,Object.create(Object.getPrototypeOf(proto),Object.getOwnPropertyDescriptors(proto)));
        Object.defineProperties(proto,Object.getOwnPropertyDescriptors(ext));
    };
    const context = vm.createContext({WeakMap, Promise, console: {warn(){}, error(){}},
        // Accelerate only the addon's OWN deadline without changing core saves.
        setTimeout(fn, delay) { return setTimeout(fn, Math.min(delay, 6)); }, clearTimeout,
    });
    const common = new vm.SyntheticModule(['FormController','Record','patch','_t'], function(){
        this.setExport('FormController',FormController);this.setExport('Record',Record);this.setExport('patch',patch);this.setExport('_t',text=>text);
    }, {context});
    const asyncSource = await readFile('odoo_addons/print_gateway/static/src/js/async_control.js','utf8');
    const asyncModule = new vm.SourceTextModule(asyncSource, {context});
    await asyncModule.link(()=>{throw Error('Unexpected async import');});
    const addon = new vm.SourceTextModule(await readFile('odoo_addons/print_gateway/static/src/js/gateway_config_auto_sync.js','utf8'),{context});
    await addon.link(name=>name==='./async_control'?asyncModule:common);
    await addon.evaluate();
    const record = new Record(); controller = new FormController();
    controller.notification = {add:(...args)=>notifications.push(args)};
    controller.model={root:record,load:async()=>{events.push('reload');if(load==='hang')return new Promise(()=>{});}};
    controller.orm={call:async()=>{events.push('sync-start');if(rpc==='hang')return new Promise(resolve=>pending.push(resolve));if(rpc==='reject')throw Error('Gateway offline');return {};}};
    controller.actionService={doAction:async()=>{events.push('action');}};
    return {record,controller,events,notifications,pending};
}
const bounded = async promise => Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve('unsettled'),55))]);

test('O-AS1 native save resolves if post-save gateway ORM never responds', async () => {
    const f=await setup({rpc:'hang'});
    assert.equal(await bounded(f.record._save()),true);
    assert.deepEqual(f.events,['native-saved','sync-start']);
    assert.ok(f.notifications.length>=1,'sync timeout must be visible to operator');
});
test('O-AS1 native save resolves if post-save form reload never responds', async () => {
    const f=await setup({load:'hang'});
    assert.equal(await bounded(f.record._save()),true);
    assert.deepEqual(f.events,['native-saved','sync-start','reload']);
});
test('O-AS1 late response after deadline cannot reload stale form', async () => {
    const f=await setup({rpc:'hang'});
    assert.equal(await bounded(f.record._save()),true);
    f.pending[0]({tag:'display_notification'});
    await Promise.resolve();await Promise.resolve();
    assert.deepEqual(f.events,['native-saved','sync-start']);
});
test('O-AS1 optional sync error is surfaced without changing an already committed native save', async () => {
    const f=await setup({rpc:'reject'});
    assert.equal(await bounded(f.record._save()),true);
    assert.equal(f.notifications.length,1);
});
test('O-AS1 notification teardown cannot turn a committed native save into rejection', async () => {
    const f=await setup({rpc:'reject'});
    f.controller.notification = {add:()=>{throw new Error('Notification service unavailable');}};
    assert.equal(await bounded(f.record._save()),true);
    assert.deepEqual(f.events,['native-saved','sync-start','reload']);
});
test('O-AS1 a failed core save is still a failure and never schedules a sync', async () => {
    const f=await setup({native:'reject'});
    await assert.rejects(f.record._save(),/Core web_save rejected/);
    assert.deepEqual(f.events,[]);
});
