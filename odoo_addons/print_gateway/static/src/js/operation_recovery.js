/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";

/**
 * Crash/reload fence for print operations with no reliable physical outcome.
 *
 * Only an opaque operation UUID is persisted. The image/PDF payload is never
 * written to localStorage: it contains customer/order information, may exceed
 * browser quotas, and is retained only inside the active renderer. Therefore
 * an unresolved operation can be re-sent with identical bytes from the SAME
 * running client, but after reload the safe recovery action is to inspect the
 * durable Print Activity/job and explicitly reprint there. In particular, a
 * storage record MUST NOT expire merely because five minutes have elapsed.
 *
 * This is a client safety fence, not authoritative deduplication: the durable
 * Odoo outbox/Gateway key and operator verification own the physical result.
 */
const PREFIX = 'yaseir.print.unresolved.v1.';

function currentDatabase() {
    if (typeof window === 'undefined') return '';
    const fromOdoo = window.odoo?.__session_info__?.db || window.odoo?.session_info?.db;
    if (typeof fromOdoo === 'string' && fromOdoo) return fromOdoo;
    const query = window.location?.search || '';
    const match = /(?:^\?|&)db=([^&]*)/.exec(query);
    return match?.[1] || '';
}

/** No raw report context or personal information is placed in storage keys. */
export function printRecoveryKey(kind, scope) {
    const source = JSON.stringify([currentDatabase(), kind, scope]);
    // Two independent non-cryptographic checksums: collision fails closed at
    // the UI, while server-side key+payload matching remains authoritative.
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let i = 0; i < source.length; i++) {
        const chr = source.charCodeAt(i);
        left = Math.imul(left ^ chr, 0x01000193);
        right = Math.imul(right ^ chr, 0x85ebca6b);
    }
    return `${PREFIX}${(left >>> 0).toString(16)}.${(right >>> 0).toString(16)}.${source.length}`;
}

function browserStore() {
    // A production browser with disabled/denied storage must fail closed.
    // Outside a browser (e.g. the Odoo-method fixture), use only RAM.
    if (typeof window === 'undefined') return null;
    const store = window.localStorage;
    if (!store || typeof store.getItem !== 'function' || typeof store.setItem !== 'function') {
        throw new Error(_t("Browser operation recovery storage is unavailable. Printing is paused."));
    }
    return store;
}

function readRecord(store, key) {
    if (!store) return null;
    const serialized = store.getItem(key);
    if (serialized === null) return null;
    let value;
    try { value = JSON.parse(serialized); }
    catch (_) { throw new Error(_t("Print recovery information is damaged. Check Print Activity before reprinting.")); }
    if (!value || value.version !== 1 || typeof value.id !== 'string' ||
        !/^[\w:.-]{12,160}$/.test(value.id) || value.phase !== 'unresolved') {
        throw new Error(_t("Print recovery information is invalid. Check Print Activity before reprinting."));
    }
    return value;
}

/**
 * Reserve BEFORE the first network submission (and preferably before render).
 * priorId/canReplay describe an identical payload still owned in live memory.
 * A page reload has neither payload nor proof of non-delivery, so it blocks.
 */
function reservePrintOperation(key, priorId, canReplay, newId) {
    const store = browserStore();
    const persisted = readRecord(store, key);
    if (persisted) {
        if (persisted.id !== priorId || !canReplay) return { blocked: true, id: persisted.id };
        return { blocked: false, id: persisted.id, newIntent: false };
    }
    const reuse = Boolean(priorId && canReplay);
    const id = reuse ? priorId : newId();
    if (store) {
        store.setItem(key, JSON.stringify({ version: 1, id, phase: 'unresolved' }));
        // Another tab could have written this slot. Never send when the value
        // is no longer ours; backend key uniqueness is the final guard.
        if (readRecord(store, key)?.id !== id) {
            return { blocked: true, id };
        }
    }
    return { blocked: false, id, newIntent: !reuse };
}

export async function claimPrintOperation(key, priorId, canReplay, newId) {
    const reserve = () => reservePrintOperation(key, priorId, canReplay, newId);
    if (typeof window === "undefined") return reserve();
    // Read/write transactions serialize across tabs, including on HTTP origins
    // where Web Locks is unavailable. The empty store holds no print data.
    return new Promise((resolve, reject) => {
        let database, transaction, result, settled = false;
        const unavailable = () => new Error(_t("Browser operation recovery storage is unavailable. Printing is paused."));
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            database?.close();
            if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => {
            transaction?.abort();
            finish(unavailable());
        }, 15000);
        try {
            const opening = window.indexedDB.open("yaseir-print-recovery-lock", 1);
            opening.onupgradeneeded = () => opening.result.createObjectStore("claims");
            opening.onerror = opening.onblocked = () => finish(unavailable());
            opening.onsuccess = () => {
                database = opening.result;
                if (settled) { database.close(); return; }
                try {
                    transaction = database.transaction("claims", "readwrite");
                    transaction.onerror = transaction.onabort = () => finish(unavailable());
                    transaction.oncomplete = () => finish();
                    transaction.objectStore("claims").get(key).onsuccess = () => {
                        if (settled) return;
                        try { result = reserve(); }
                        catch (error) { finish(error); transaction.abort(); }
                    };
                } catch { finish(unavailable()); }
            };
        } catch { finish(unavailable()); }
    });
}

export function finishPrintOperation(key, operationId) {
    const store = browserStore();
    if (store && readRecord(store, key)?.id === operationId) {
        store.removeItem(key);
    }
}
