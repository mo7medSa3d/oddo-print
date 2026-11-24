/** Narrow IndexedDB boundary fixture: readwrite callbacks run in FIFO order. */
import assert from "node:assert/strict";

export function recoveryIndexedDB() {
    let queue = Promise.resolve();
    return { open() {
        const opening = {};
        queueMicrotask(() => {
            opening.result = {
                createObjectStore() {}, close() {},
                transaction(store, mode) {
                    assert.equal(store, "claims");
                    assert.equal(mode, "readwrite", "Readonly transactions cannot serialize reservations");
                    let aborted = false;
                    const transaction = {
                        abort() { aborted = true; transaction.onabort?.(); },
                        objectStore() { return { get() {
                            const request = {};
                            queue = queue.then(() => {
                                if (aborted) return;
                                request.onsuccess?.();
                                if (!aborted) transaction.oncomplete?.();
                            });
                            return request;
                        } }; },
                    };
                    return transaction;
                },
            };
            opening.onsuccess?.();
        });
        return opening;
    } };
}
