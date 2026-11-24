import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { recoveryIndexedDB } from "./helpers/odoo-recovery-indexeddb.mjs";

async function recovery(storage, indexedDB) {
    const context = vm.createContext({ window: { localStorage: storage, indexedDB }, setTimeout, clearTimeout });
    const translations = new vm.SyntheticModule(["_t"], function () { this.setExport("_t", value => value); }, { context });
    const recoveryModule = new vm.SourceTextModule(await readFile(new URL(
        "../odoo_addons/print_gateway/static/src/js/operation_recovery.js", import.meta.url), "utf8"), { context });
    await recoveryModule.link(() => translations);
    await recoveryModule.evaluate();
    return recoveryModule.namespace;
}

test("two tabs cannot reserve different UUIDs after both observe empty recovery storage", async () => {
    const records = new Map();
    let otherClaim, race;
    const storage = {
        getItem(key) {
            const snapshot = records.get(key) ?? null;
            // Cross-process localStorage reads can interleave this way. The
            // second tab starts before the first read's empty snapshot returns.
            if (race) { const start = race; race = null; otherClaim = start(); }
            return snapshot;
        },
        setItem: (key, value) => records.set(key, value),
        removeItem: key => records.delete(key),
    };
    const indexedDB = recoveryIndexedDB();
    const first = await recovery(storage, indexedDB);
    const second = await recovery(storage, indexedDB);
    race = () => second.claimPrintOperation("same-print", null, false, () => "second-uuid-1234");
    const claim = await first.claimPrintOperation("same-print", null, false, () => "first-uuid-1234");
    const other = await otherClaim;
    assert.equal([claim, other].filter(value => !value.blocked).length, 1,
        "Different UUIDs bypass durable server idempotency and print twice");
});

test("unavailable cross-tab storage cannot authorize a fresh print", async () => {
    let generated = false;
    const recoveryModule = await recovery({}, undefined);
    await assert.rejects(recoveryModule.claimPrintOperation("same-print", null, false, () => { generated = true; }), /Browser operation recovery storage is unavailable/);
    assert.equal(generated, false);
});
