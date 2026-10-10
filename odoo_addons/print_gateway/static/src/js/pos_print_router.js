/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { gatewayServerMessage, showGatewayBillingLimitDialog } from "./gateway_limit_dialog";
import { isGatewayTimeoutError, withGatewayDeadline } from "./async_control";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";
import { renderToElement } from "@web/core/utils/render";
import { renderGatewayReceiptJpeg, normalizedReceiptRasterWidth, DEFAULT_RECEIPT_RASTER_WIDTH } from "./receipt_raster";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { RetryPrintPopup } from "@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup";
import { printRecoveryKey, claimPrintOperation, finishPrintOperation } from "./operation_recovery";


const POS_RPC_TIMEOUT_MS = 20000;
const POS_RENDER_TIMEOUT_MS = 15000;
const POS_SYNC_TIMEOUT_MS = 20000;

// Odoo 19's updateLastOrderChange() intentionally reads *live* order lines.
// For a remote kitchen submission that waits on rendering/RPC, the live order
// may have changed since the physical ticket was captured. Apply that native
// accounting algorithm to a snapshot façade, not to edited live lines.
function captureKitchenPreparationState(order) {
    if (!Array.isArray(order?.lines) || !order?.last_order_preparation_change ||
        typeof order.updateLastOrderChange !== "function") {
        return null;
    }
    const lineRecords = order.lines.map((line) => {
        const product = line.getProduct();
        const quantity = line.getQuantity();
        const note = line.getNote();
        const customerNote = line.getCustomerNote();
        const fullName = line.getFullProductName();
        const captured = {
            uuid: line.uuid,
            preparationKey: line.preparationKey,
            attribute_value_ids: (line.attribute_value_ids || []).map((attr) => ({ name: attr.name })),
            combo_line_ids: new Array(line.combo_line_ids?.length || 0),
            combo_parent_id: line.combo_parent_id ? { uuid: line.combo_parent_id.uuid } : null,
            product_id: product ? { ...product } : null,
            getProduct() { return product; },
            getQuantity() { return quantity; },
            getNote() { return note; },
            getCustomerNote() { return customerNote; },
            getFullProductName() { return fullName; },
            setHasChange() {},
            uiState: { savedQuantity: quantity },
            note,
            qty: quantity,
        };
        return captured;
    });
    const original = order.last_order_preparation_change;
    const previous = {
        ...original,
        lines: Object.fromEntries(Object.entries(original.lines || {}).map(([key, value]) =>
            [key, { ...value, attribute_value_names: value.attribute_value_names?.slice() }])),
        metadata: { ...(original.metadata || {}) },
    };
    return {
        lines: lineRecords,
        last_order_preparation_change: previous,
        models: { "pos.order.line": {
            getBy(field, uuid) {
                return field === "uuid" ? lineRecords.find((line) => line.uuid === uuid) : undefined;
            },
        } },
        general_customer_note: order.general_customer_note,
        internal_note: order.internal_note,
        preset_id: order.preset_id ? { id: order.preset_id.id } : null,
        _markDirty() {},
    };
}

function consumeAcceptedKitchenSnapshot(order, snapshot) {
    // A missing snapshot is allowed only for simplified nonproduction order
    // fixtures. Real POS models always supply lines and preparation state.
    if (!snapshot) {
        order.updateLastOrderChange();
        return;
    }
    // Native Odoo's method is the single source of accounting truth, but it
    // executes on the immutable façade captured before the asynchronous work.
    order.updateLastOrderChange.call(snapshot);
    Object.assign(order.last_order_preparation_change, snapshot.last_order_preparation_change);
    for (const line of order.lines) {
        const acknowledged = snapshot.lines.find((item) => item.uuid === line.uuid);
        if (acknowledged) {
            line.uiState.savedQuantity = acknowledged.getQuantity();
            // An in-flight note/quantity change must remain pending. Only
            // acknowledge the unchanged line; the next native calculation
            // will detect fresh deltas against the captured snapshot.
            if (line.getQuantity() === acknowledged.getQuantity() &&
                line.getNote() === acknowledged.getNote() &&
                line.getCustomerNote() === acknowledged.getCustomerNote()) {
                line.setHasChange(false);
            } else {
                line.setHasChange(true);
            }
        }
    }
    order._markDirty();
}

// Ownership covers the whole preparation operation, including metadata,
// rendering, change consumption and synchronization. Nested calls may borrow
// only the exact owner token; unrelated sends/retries are coalesced.
async function withKitchenOperation(store, order, dispatch, owner = null) {
    const pending = (store.gatewayKitchenPending ||= new Map());
    const key = order?.uuid || order;
    if (owner && pending.get(key) === owner) {
        return dispatch(owner);
    }
    if (pending.has(key)) {
        return false;
    }
    const token = {
        release: () => { if (pending.get(key) === token) pending.delete(key); },
    };
    pending.set(key, token);
    try {
        return await dispatch(token);
    } finally {
        token.release();
    }
}

function gatewayDataCall(store, model, method, args, kwargs = {}, silent = true, { ambiguous = false } = {}) {
    return withGatewayDeadline(
        () => store.data.call(model, method, args, kwargs, silent),
        POS_RPC_TIMEOUT_MS,
        _t("Printing service request timed out."),
        { ambiguous },
    );
}

function gatewaySilentCall(store, model, method, args, kwargs = {}) {
    return withGatewayDeadline(
        () => store.data.silentCall(model, method, args, kwargs),
        POS_RPC_TIMEOUT_MS,
        _t("Printing service update timed out."),
    );
}

function gatewaySync(store, options) {
    return withGatewayDeadline(
        () => store.syncAllOrders(options),
        POS_SYNC_TIMEOUT_MS,
        _t("Order synchronization timed out."),
    );
}

function gatewayRender(factory) {
    return withGatewayDeadline(
        factory,
        POS_RENDER_TIMEOUT_MS,
        _t("Receipt rendering timed out."),
    );
}

// crypto.randomUUID() is undefined in non-secure contexts (plain-HTTP LAN,
// which this integration otherwise tolerates). Fall back to a v4 UUID so
// kitchen/reprint operation identities never throw and abort printChanges.
// getRandomValues is available even in non-secure contexts; if neither source
// exists the UUID would be predictable (Math.random) and could collapse
// distinct reprint idempotency keys, so fail closed instead.
function gatewayUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        crypto.getRandomValues(bytes);
    } else {
        throw new Error(_t("Secure random number generator is unavailable; cannot generate print operation idempotency key"));
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function elementToJpeg(element, renderer, width = DEFAULT_RECEIPT_RASTER_WIDTH) {
    return renderGatewayReceiptJpeg(element, { renderer, width });
}

// Diagnostic tracing must NEVER change print behavior. Odoo embedded runtimes
// and tests may expose only console.log; even a failing logger must not turn
// a successfully rendered receipt into a new retryable print attempt.
function recordReceiptLatency(stage, startedAt) {
    try {
        const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        const message = "print.trace " + stage + " latency_ms=" + Math.max(0, Math.round(elapsed));
        const logger = globalThis.console;
        if (typeof logger?.info === "function") {
            logger.info(message);
        } else if (typeof logger?.log === "function") {
            logger.log(message);
        }
    } catch {
        // Observability is best-effort and must not affect print identity or output.
    }
}

export async function renderReceiptImage(pos, currentOrder, basic = false, rasterWidth = DEFAULT_RECEIPT_RASTER_WIDTH) {
    const renderStartedAt = globalThis.performance?.now?.() ?? Date.now();
    try {
    const renderer = pos.env?.services?.renderer || pos.printer?.renderer;
    const props = { order: currentOrder, basic_receipt: Boolean(basic) };
    const receiptComponent = pos.orderReceiptComponent || OrderReceipt;

    // Every Gateway image must use the SAME mounted, width-measured receipt
    // pipeline. Odoo's general toJpeg/toCanvas helpers ignore the printer's
    // printable dot width and can silently clip a verified-overflow receipt.
    // A geometry failure is terminal; retrying through an unmeasured renderer
    // would send precisely the cropped ticket we are trying to prevent.
    if (renderer && typeof renderer.toHtml === "function") {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const element = await renderer.toHtml(receiptComponent, props);
                return await elementToJpeg(element, renderer, rasterWidth);
            } catch (err) {
                if (err?.code === "POS_RECEIPT_GEOMETRY") {
                    throw err;
                }
                console.warn("Mounted receipt rasterization failed; retrying with a fresh source:", err);
            }
        }
    }

    // A genuine Odoo renderer failure may still fall back to the template,
    // but it must pass through the *same* width/overflow-checked capture.
    // Never fall back to arbitrary canvas dimensions or default page zoom.
    const receipt = renderToElement(receiptComponent.template || "point_of_sale.OrderReceipt", props);
    return await elementToJpeg(receipt, renderer, rasterWidth);
    } finally {
        // Render time is distinct from Gateway enqueue and physical printing;
        // no receipt, order, printer or customer data is included in the log.
        recordReceiptLatency("pos_receipt_render", renderStartedAt);
    }
}

// Width is resolved for the ACTUAL bound printer on EACH print action,
// not cached by POS config: the same POS can switch between 58mm and 80mm
// bindings inside five minutes. Reusing config-wide geometry made receipts
// clip or shrink after a routing/driver change. Fetch once per action; not
// per receipt line. The Agent independently clamps to hardware limits.
async function gatewayReceiptRasterWidth(pos, orderId) {
    const lookupStartedAt = globalThis.performance?.now?.() ?? Date.now();
    let width = DEFAULT_RECEIPT_RASTER_WIDTH;
    try {
        const candidate = await gatewayDataCall(
            pos, "pos.order", "get_gateway_receipt_raster_width", [[orderId]], {}, true,
        );
        width = normalizedReceiptRasterWidth(candidate);
    } catch (error) {
        // A missing/stale metadata endpoint must not force fallback to local
        // browser printing. The Gateway will still authorize the real job.
        console.warn("Gateway printer width unavailable; using Odoo's native receipt width:", error);
    } finally {
        // The width RPC can be slow even when the printer and Gateway are fast.
        // Do not cache across actions: routing may change from 58mm to 80mm.
        recordReceiptLatency("pos_width_lookup", lookupStartedAt);
    }
    return width;
}

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        if (!currentOrder) {
            this.notification.add(_t("No POS order is available for printing."), { type: "danger" });
            return false;
        }

        // Acquire the guard before ANY await (activation, synchronization,
        // metadata or rendering). Otherwise two slow renders can both finish
        // after the other's submit guard was released and print twice.
        const pendingReceipts = (this.gatewayReceiptPending ||= new Set());
        const pendingKey = currentOrder.uuid || currentOrder.id || currentOrder;
        if (pendingReceipts.has(pendingKey)) {
            return false;
        }
        pendingReceipts.add(pendingKey);
        let activePrintClaim = null;
        let submissionAttempted = false;
        try {
            const sessionId = this.session?.id;
            const gatewayEnabled = sessionId
                ? await gatewayDataCall(this, "pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                : false;

            if (gatewayEnabled !== true) {
                return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
            }

            // The Gateway path requires a persisted server-side order id; synchronize an unsynced order
            // before rendering/submitting so the print request has a durable Odoo record.
            if (!currentOrder.isSynced) {
                try {
                    await gatewaySync(this, { orders: [currentOrder], force: false, throw: false });
                } catch (syncErr) {
                    console.warn("Background order synchronization skipped or pending:", syncErr);
                }
            }

            const orderId = currentOrder.id;
            if (!Number.isInteger(orderId) || orderId <= 0) {
                console.warn("POS order has no server identifier; cannot print via Gateway without synced record:", currentOrder.uuid || currentOrder.name);
                this.notification.add(_t("Sync the POS order before sending the receipt to the printing service."), { type: "warning" });
                return false;
            }

            // The browser persists ONLY the unresolved operation ID, not the
            // sensitive raster. A retry in this live POS can replay identical
            // bytes for as long as necessary. After reload, there are no
            // original bytes; never replace the lost identity with a new job.
            const receiptOps = (this.gatewayReceiptOperations ||= new Map());
            const lastOp = receiptOps.get(orderId);
            const memoryRetry = Boolean(lastOp?.terminal === false && lastOp?.image);
            const recoveryKey = printRecoveryKey("receipt", [
                this.env?.services?.user?.userId || this.user?.id || 0,
                this.company?.id || this.env?.services?.company?.currentCompany?.id || 0,
                sessionId, this.config?.id || 0, orderId, currentOrder.uuid || "",
                Boolean(basic),
            ]);
            const claim = claimPrintOperation(
                recoveryKey, memoryRetry ? lastOp.id : null,
                memoryRetry, gatewayUuid,
            );
            if (claim.blocked) {
                this.notification.add(
                    _t("An earlier receipt print is unresolved after this page changed. Check Print Activity and the printer. To print again, use the explicit reprint action in Print Activity; a new print is not sent automatically."),
                    { type: "warning", sticky: true },
                );
                return false;
            }
            activePrintClaim = { recoveryKey, id: claim.id, newIntent: claim.newIntent, orderId };
            const operationId = claim.id;
            let image = memoryRetry ? lastOp.image : undefined;
            if (!memoryRetry) {
                const rasterWidth = await gatewayReceiptRasterWidth(this, orderId);
                image = await gatewayRender(() => renderReceiptImage(this, currentOrder, basic, rasterWidth));
            }
            receiptOps.set(orderId, { id: operationId, image, terminal: false, at: Date.now(), counted: lastOp?.id === operationId && lastOp.counted });
            let result;
            try {
                submissionAttempted = true;
                result = await gatewayDataCall(
                    this,
                    "pos.order",
                    "action_print_gateway_receipt",
                    [[orderId]],
                    { image, operation_id: operationId },
                    true,
                    { ambiguous: true },
                );
            } catch (rpcError) {
                receiptOps.set(orderId, { id: operationId, image, at: Date.now(), terminal: false });
                throw rpcError;
            }
            // Resolve the operation: definitive outcomes (accepted for
            // printing, or definitively rejected) close the reuse window;
            // uncertain statuses keep it for a retry. Transport failures are
            // recorded uncertain by the inner catch above.
            const terminal = ["submitted", "claimed", "printing", "success", "failed"].includes(result?.status);
            if (terminal) finishPrintOperation(recoveryKey, operationId);
            receiptOps.set(orderId, {
                id: operationId,
                // Queued and uncertain operations keep the EXACT raster for replay.
                image: terminal ? undefined : image,
                at: Date.now(),
                terminal,
                counted: lastOp?.id === operationId && lastOp.counted,
            });

            // Truthful feedback: "submitted" means QUEUED for the agent, not
            // printed; "unknown" means the outcome cannot be trusted. Only
            // allowlisted accepted statuses render success; an absent or
            // unexpected status must never toast success.
            if (["unknown", "partial"].includes(result?.status)) {
                this.notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true }
                );
            } else if (result?.status === "failed") {
                this.notification.add(
                    result?.message || _t("Couldn't print the receipt. See Print Activity."),
                    { type: "danger" }
                );
            } else if (["queued", "submitted", "claimed", "printing", "success"].includes(result?.status)) {
                this.notification.add(
                    result?.message || _t("Receipt sent. Check Print Activity for the result."),
                    { type: "success" }
                );
            } else {
                this.notification.add(
                    result?.message || _t("Couldn't print the receipt. See Print Activity."),
                    { type: "danger" }
                );
            }

            // Count only accepted/known print outcomes. A definite Gateway
            // rejection or an ambiguous physical outcome must not be recorded
            // as a completed POS print. Allowlist (mirrors the kitchen path):
            // an absent/unexpected status must never count as success.
            const recordPrintAttempt = ["queued", "submitted", "claimed", "printing", "success"].includes(result?.status);
            if (!printBillActionTriggered && recordPrintAttempt && !receiptOps.get(orderId)?.counted) {
                receiptOps.get(orderId).counted = true;
                const count = currentOrder.nb_print ? currentOrder.nb_print + 1 : 1;
                try {
                    const writeResult = await gatewaySilentCall(
                        this,
                        "pos.order",
                        "write",
                        [[orderId], { nb_print: count }],
                    );
                    // Odoo 19 silentCall() returns false when the RPC fails
                    // instead of throwing. Keep the local model in sync only
                    // after the server accepted the count update.
                    if (writeResult !== false) {
                        currentOrder.nb_print = count;
                    }
                } catch (writeErr) {
                    console.warn("Failed to record receipt print count:", writeErr);
                }
            }
            return recordPrintAttempt;
        } catch (error) {
            // A rendering/metadata failure before dispatch cannot have sent
            // paper; a new reservation may be released. Once RPC was tried,
            // preserve the identity even on exception or malformed response.
            if (activePrintClaim && !submissionAttempted && activePrintClaim.newIntent) {
                finishPrintOperation(activePrintClaim.recoveryKey, activePrintClaim.id);
                const saved = this.gatewayReceiptOperations?.get(activePrintClaim.orderId);
                if (saved?.id === activePrintClaim.id) this.gatewayReceiptOperations.delete(activePrintClaim.orderId);
            }
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return false;
            }
            // Fail-safe: display user notification and return false, NEVER re-throw to avoid freezing POS UI.
            // Read the server-side message (error.data.message), not the
            // generic RPC title (error.message is "Odoo Server Error" for
            // every deterministic printer failure).
            if (isGatewayTimeoutError(error) && error.gatewayAmbiguous) {
                this.notification.add(
                    _t("The printing service did not confirm the result in time. The receipt may already have been accepted; retry will reuse the same operation to prevent a duplicate."),
                    { type: "warning", sticky: true },
                );
                return false;
            }
            this.notification.add(gatewayServerMessage(error) || _t("Receipt printing failed."), { type: "danger" });
            return false;
        } finally {
            pendingReceipts.delete(pendingKey);
        }
    },

    getOrderData(order, reprint) {
        const data = super.getOrderData(order, reprint);
        return {
            ...data,
            __gateway_order_id: order.id,
            __gateway_session_id: this.session?.id,
            __gateway_reprint: Boolean(reprint),
        };
    },

    generateOrderChange(order, orderChange, categories, reprint = false) {
        // A kitchen reprint is a new physical print operation even though it
        // intentionally reuses the same preparation change. Generate a fresh
        // operation identity so Gateway idempotency cannot collapse the reprint
        // into the original ticket.
        if (reprint || !orderChange.__gateway_print_id) {
            orderChange.__gateway_print_id = gatewayUuid();
        }
        const result = super.generateOrderChange(order, orderChange, categories, reprint);
        if (result?.orderData) {
            result.orderData.__gateway_print_id = orderChange.__gateway_print_id;
        }
        return result;
    },

    async generateReceiptsDataToPrint(orderData, changes, orderChange) {
        const receiptsData = await super.generateReceiptsDataToPrint(orderData, changes, orderChange);
        const operationId = orderData?.__gateway_print_id;
        if (!operationId) {
            return receiptsData;
        }
        receiptsData.forEach((receiptData, index) => {
            receiptData.orderData.__gateway_print_id = `${operationId}:${index}`;
        });
        return receiptsData;
    },

    async sendOrderInPreparation(order, opts = {}) {
        return withKitchenOperation(this, order, async (owner) => {
            const sessionId = this.session?.id;
            let gatewayEnabled;
            try {
                gatewayEnabled = sessionId
                    ? await gatewayDataCall(this, "pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                    : false;
            } catch (error) {
                this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
                return false;
            }
            if (gatewayEnabled !== true) {
                // Core preparation calls this.printChanges itself without a
                // Gateway owner token. Let native orchestration own that path.
                owner.release();
                return super.sendOrderInPreparation(order, opts);
            }

            // Gateway dispatch needs a durable server-side order id. Odoo 19
            // syncAllOrders excludes entries already in syncingOrders, so save
            // a new order BEFORE acquiring the native preparation-print guard.
            // Otherwise the first kitchen send silently skips sync, fails the
            // id check, and only saves the order after the ticket was rejected.
            if (!opts.byPassPrint && (!order?.isSynced || !Number.isInteger(order?.id) || order.id <= 0)) {
                try {
                    await gatewaySync(this, { orders: [order], force: true, throw: true });
                    if (!Number.isInteger(order?.id) || order.id <= 0) {
                        throw new Error(_t("The POS order is not synchronized yet, so kitchen printing cannot continue."));
                    }
                } catch (error) {
                    this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
                    return false;
                }
            }

            let isPrinted = false;
            let hasChanges = false;
            let reprint = false;
            let preparationSnapshot = null;
            try {
                this.syncingOrders.add(order.uuid);

                if (!opts.byPassPrint) {

                    // Odoo 19 defines the preparation scope from native
                    // pos.printer.product_categories_ids. Gateway changes only the
                    // physical destination; it must not expand the business scope
                    // to every product category loaded in the POS.
                    const gatewayCategories = this.config.printerCategories;
                    let orderChange = changesToOrder(order, gatewayCategories, opts.cancelled);
                    preparationSnapshot = captureKitchenPreparationState(order);
                    hasChanges =
                        orderChange.new.length ||
                        orderChange.cancelled.length ||
                        orderChange.noteUpdate.length ||
                        orderChange.internal_note ||
                        orderChange.general_customer_note;

                    let shouldPrint = true;
                    if (!hasChanges) {
                        if (opts.explicitReprint && order.uiState.lastPrints) {
                            orderChange = [order.uiState.lastPrints.at(-1)];
                            reprint = true;
                        } else {
                            shouldPrint = false;
                        }
                    } else {
                        orderChange = [orderChange];
                    }

                    if (reprint && opts.orderDone) {
                        shouldPrint = false;
                    }

                    if (shouldPrint) {
                        isPrinted = await this.printChanges(order, orderChange, reprint, this.unwatched.printers, owner, preparationSnapshot);
                    }
                }

                // Preserve the Odoo 19 core order-change lifecycle:
                // consume the preparation change only after a Gateway print is
                // accepted, or when there is no preparation printer to print to.
                if (isPrinted && !reprint && hasChanges) {
                    consumeAcceptedKitchenSnapshot(order, preparationSnapshot);
                    order.uiState.gatewayKitchenAttempts = {};
                    order.uiState.gatewayKitchenPendingKeys = [];
                    order.uiState.gatewayKitchenOperationIds = {};
                } else {
                    this.updateLastOrderChangeIfNoDevice(order, opts);
                }
            } finally {
                this.syncingOrders.delete(order.uuid);
            }

            // Match Odoo 19 core: after preparation printing, synchronize the
            // changed order unless a preparation display already owns the sync.
            // Without this, another POS device can observe the same change and
            // submit the kitchen ticket again.
            if (!this.models["pos.prep.display"]?.length) {
                try {
                    await gatewaySync(this, { orders: [order] });
                } catch (error) {
                    // Accepted tickets stay accepted even if their bookkeeping
                    // cannot synchronize yet. Never reopen a physical retry.
                    console.warn("Kitchen preparation could not be synchronized:", error);
                    this.notification.add(gatewayServerMessage(error) || _t("Order synchronization timed out."), { type: "warning", sticky: true });
                }
            }

            return isPrinted;
        });
    },

    async printChanges(
        order,
        orderChange,
        reprint = false,
        printers = this.unwatched.printers,
        gatewayOwner = null,
        preparationSnapshot = null
    ) {
        return withKitchenOperation(this, order, async (owner) => {
            // A direct native printChanges call also needs its own immutable
            // dispatch accounting state. An owning sendOrderInPreparation call
            // passes the earlier capture to preserve identical retry evidence.
            preparationSnapshot ||= captureKitchenPreparationState(order);
            const sessionId = this.session?.id;
            let gatewayEnabled;
            try {
                gatewayEnabled = sessionId
                    ? await gatewayDataCall(this, "pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                    : false;
            } catch (error) {
                this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
                return false;
            }
            if (gatewayEnabled !== true) {
                owner.release();
                return super.printChanges(order, orderChange, reprint, printers);
            }

            try {
                if (!order?.isSynced || !Number.isInteger(order?.id)) {
                    await gatewaySync(this, { orders: [order], force: false, throw: true });
                }
            } catch (error) {
                this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
                return false;
            }
            const orderId = order?.id;
            if (!Number.isInteger(orderId) || orderId <= 0) {
                const message = _t("The POS order is not synchronized yet, so kitchen printing cannot continue.");
                this.notification.add(message, { type: "danger" });
                return false;
            }

            try {
                const kitchenRoutes = await gatewayDataCall(
                    this,
                    "pos.order",
                    "get_gateway_kitchen_routes",
                    [[orderId]],
                    {},
                    true,
                );
                if (!kitchenRoutes || !Array.isArray(kitchenRoutes.routes)) {
                    this.notification.add(
                        _t("Gateway returned an invalid kitchen-routing configuration."),
                        { type: "danger", sticky: true }
                    );
                    return false;
                }

                const missingRoutes = Array.isArray(kitchenRoutes.missing_routes)
                    ? kitchenRoutes.missing_routes
                    : [];
                const retryAttempt = printers instanceof Set;
                const requestedPrinterIds = retryAttempt
                    ? new Set(Array.from(printers || []).map((printer) => printer?.id).filter(Boolean))
                    : null;
                const routes = retryAttempt
                    ? kitchenRoutes.routes.filter((route) => requestedPrinterIds.has(route.pos_printer_id))
                    : kitchenRoutes.routes;

                if (missingRoutes.length && !retryAttempt) {
                    const changedCategoryIds = new Set();
                    for (const change of orderChange || []) {
                        for (const key of ["new", "cancelled", "noteUpdate"]) {
                            for (const line of change?.[key] || []) {
                                const product = this.models["product.product"].get(line.product_id);
                                for (const categoryId of product?.parentPosCategIds || []) {
                                    changedCategoryIds.add(categoryId);
                                }
                            }
                        }
                    }
                    const uncovered = missingRoutes.filter((route) =>
                        (route.category_ids || []).some((categoryId) => changedCategoryIds.has(categoryId))
                    );
                    if (uncovered.length) {
                        this.notification.add(
                            _t("Gateway Kitchen routing is incomplete for one or more Odoo Preparation Printers. Printing was cancelled to prevent silently losing kitchen tickets."),
                            { type: "danger", sticky: true }
                        );
                        return false;
                    }
                }

                if (!routes.length) {
                    this.notification.add(
                        retryAttempt
                            ? _t("The previously failed kitchen printer is no longer available in the current POS configuration.")
                            : _t("Gateway printing is enabled for this POS, but no Gateway Kitchen binding is configured for an Odoo preparation printer."),
                        { type: "danger", sticky: true }
                    );
                    return false;
                }

                let isPrinted = false;
                let allAccepted = true;
                const unsuccessfulPrints = [];
                const retryPrinters = new Set();
                const attempts = order.uiState.gatewayKitchenAttempts ||= {};
                const pendingKeys = order.uiState.gatewayKitchenPendingKeys ||= [];
                const printerById = new Map(
                    Array.from(printers || [])
                        .filter((printer) => printer?.id)
                        .map((printer) => [printer.id, printer])
                );

                for (const route of routes) {
                    const routeCategories = Array.isArray(route.category_ids) ? route.category_ids : [];

                    for (const change of orderChange) {
                        const changeIdentity = JSON.stringify(change, (key, value) => key === "__gateway_print_id" ? undefined : value);
                        const { orderData, changes } = this.generateOrderChange(
                            order,
                            change,
                            routeCategories,
                            reprint
                        );
                        const receiptsData = await this.generateReceiptsDataToPrint(
                            orderData,
                            changes,
                            change
                        );

                        receiptsData.forEach((data, index) => {
                            const baseOperation = data?.orderData?.__gateway_print_id;
                            if (baseOperation) {
                                data.orderData.__gateway_print_id =
                                    baseOperation + ":" +
                                    String(route.pos_printer_id || "pos") + ":" +
                                    String(index);
                            }
                        });

                        for (const [receiptIndex, data] of receiptsData.entries()) {
                            const printer = printerById.get(route.pos_printer_id);
                            const attemptKey = `${route.pos_printer_id}:${receiptIndex}:${changeIdentity}`;
                            if (!reprint && !pendingKeys.includes(attemptKey)) pendingKeys.push(attemptKey);
                            const prior = !reprint ? attempts[attemptKey] : null;
                            order.uiState.gatewayKitchenOperationIds ||= {};
                            const identities = order.uiState.gatewayKitchenOperationIds;
                            if (!reprint) {
                                if (retryAttempt && prior?.gatewayOutcome === "failed" && prior?.canRetry !== false) {
                                    // Explicit retry after a confirmed rejection may create a new operation.
                                    identities[attemptKey] = "kitchen-retry-" + gatewayUuid();
                                }
                                identities[attemptKey] ||= data.orderData.__gateway_print_id;
                                data.orderData.__gateway_print_id = identities[attemptKey];
                            }
                            const reusable = prior?.successful || ["unknown", "partial"].includes(prior?.gatewayOutcome);
                            const result = (reusable ? prior : null) || await this.printOrderChanges(
                                data,
                                printer,
                                route.pos_printer_id || null,
                                route.raster_width
                            );
                            if (!reprint) attempts[attemptKey] = result;

                            if (result?.gatewayOutcome === "unknown" || result?.gatewayOutcome === "partial") {
                                this.notification.add(
                                    result?.message?.body ||
                                        _t("Kitchen print status is unknown. Check the printer before trying again."),
                                    { type: "warning", sticky: true }
                                );
                                allAccepted = false;
                                continue;
                            }

                            if (result?.successful) {
                                isPrinted = true;
                            } else {
                                allAccepted = false;
                                if (printer && result?.canRetry !== false) {
                                    retryPrinters.add(printer);
                                }
                                unsuccessfulPrints.push(
                                    printer?.config?.name ||
                                        _t("Odoo Preparation Printer %s: %s", String(route.pos_printer_id), result?.message?.body || _t("print failed"))
                                );
                                if (result?.message?.body && printer?.config?.name) {
                                    unsuccessfulPrints[unsuccessfulPrints.length - 1] =
                                        printer.config.name + ": " + result.message.body;
                                }
                            }

                            if (result?.successful && result.warningCode) {
                                this.displayPrinterWarning(
                                    result,
                                    printer?.config?.name || _t("Gateway Kitchen")
                                );
                            }
                        }
                    }
                }

                const batchAccepted = reprint || pendingKeys.every((key) => attempts[key]?.successful);
                if (!reprint && isPrinted && allAccepted && batchAccepted && orderChange.length) {
                    order.uiState.lastPrints.push(orderChange[0]);
                }

                if (unsuccessfulPrints.length && retryPrinters.size) {
                    const failedReceipts = unsuccessfulPrints.join("\n");
                    this.dialog.add(RetryPrintPopup, {
                        message: failedReceipts,
                        canRetry: true,
                        retry: () => withKitchenOperation(this, order, async (retryOwner) => {
                            const accepted = await this.printChanges(order, orderChange, reprint, retryPrinters, retryOwner, preparationSnapshot);
                            if (accepted && !reprint) {
                                consumeAcceptedKitchenSnapshot(order, preparationSnapshot);
                                order.uiState.gatewayKitchenAttempts = {};
                                order.uiState.gatewayKitchenPendingKeys = [];
                                order.uiState.gatewayKitchenOperationIds = {};
                                // This callback runs after sendOrderInPreparation
                                // has returned. Persist the consumed change here
                                // too, or another POS can print the same ticket.
                                if (!this.models["pos.prep.display"]?.length) {
                                    try {
                                        await gatewaySync(this, { orders: [order] });
                                    } catch (error) {
                                        // The ticket was already accepted. A sync
                                        // failure must not reopen physical retry.
                                        console.warn("Accepted kitchen retry could not be synchronized:", error);
                                        this.notification.add(gatewayServerMessage(error) || _t("Order synchronization timed out."), { type: "warning", sticky: true });
                                    }
                                }
                            }
                            return accepted;
                        }),
                    });
                }

                return isPrinted && allAccepted && batchAccepted;
            } catch (error) {
                if (showGatewayBillingLimitDialog(this.env, error)) {
                    return false;
                }
                this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), {
                    type: "danger",
                });
                return false;
            }
        }, gatewayOwner);
    },
    async printOrderChanges(data, printer, posPrinterId = null, rasterWidth = DEFAULT_RECEIPT_RASTER_WIDTH) {
        const orderId = data?.orderData?.__gateway_order_id;
        const sessionId = data?.orderData?.__gateway_session_id;
        const reprint = Boolean(data?.orderData?.__gateway_reprint);
        const operationId = data?.orderData?.__gateway_print_id;

        let gatewayEnabled;
        try {
            gatewayEnabled = sessionId
                ? await gatewayDataCall(this, "pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                : false;
        } catch (error) {
            this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
            return { successful: false, canRetry: true, message: { title: _t("Printing Service"), body: gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed.") } };
        }
        if (gatewayEnabled !== true) {
            return super.printOrderChanges(data, printer);
        }
        if (!Number.isInteger(orderId) || orderId <= 0) {
            const message = _t("The POS order is not synchronized yet, so kitchen printing cannot continue.");
            this.notification.add(message, { type: "danger" });
            return {
                successful: false,
                canRetry: true,
                message: { title: _t("Printing Service"), body: message },
            };
        }

        let submissionStarted = false;
        try {
            const receipt = renderToElement("point_of_sale.OrderChangeReceipt", { data });
            const image = await gatewayRender(() =>
                elementToJpeg(receipt, this.env.services.renderer, rasterWidth)
            );
            submissionStarted = true;
            const result = await gatewayDataCall(
                this,
                "pos.order",
                "action_print_gateway_kitchen",
                [[orderId]],
                {
                    image,
                    reprint,
                    operation_id: operationId,
                    pos_printer_id: posPrinterId || undefined,
                },
                true,
                { ambiguous: true },
            );
            const status = result?.status;
            const accepted = ["queued", "submitted", "claimed", "printing", "success"].includes(status);
            if (!accepted && status !== "failed") {
                // Missing/unrecognized responses give no proof of refusal.
                // They must not expose a fresh-operation retry.
                const outcome = status === "partial" ? "partial" : "unknown";
                return {
                    successful: false,
                    gatewayOutcome: outcome,
                    canRetry: false,
                    warningCode: undefined,
                    message: {
                        title: _t("Printing Service"),
                        body: outcome === "unknown"
                            ? _t("Kitchen print outcome is unknown. The ticket may already have printed; automatic retry is disabled.")
                            : _t("Kitchen print status is unclear. Automatic retry is paused to prevent duplicate tickets."),
                    },
                };
            }
            if (result?.message) showGatewayBillingLimitDialog(this.env, result.message);
            return {
                successful: accepted,
                canRetry: !accepted && result?.can_retry !== false,
                warningCode: undefined,
                gatewayOutcome: status,
                message: accepted ? undefined : {
                    title: _t("Printing Service"),
                    body: result?.message || _t("Kitchen / Preparation printing failed."),
                },
            };
        } catch (error) {
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return {
                    successful: false,
                    canRetry: false,
                    message: { title: _t("Printing Service"), body: _t("The Gateway plan limit has been reached.") },
                };
            }
            // Local rendering/geometry errors cannot have printed anything.
            // Only an attempted submission can have an ambiguous outcome.
            const message = gatewayServerMessage(error) || (submissionStarted
                ? _t("Kitchen print outcome is unknown. The ticket may already have printed; automatic retry is disabled.")
                : _t("Kitchen / Preparation printing failed."));
            this.notification.add(message, { type: submissionStarted ? "warning" : "danger", sticky: true });
            return {
                successful: false,
                gatewayOutcome: submissionStarted ? "unknown" : "failed",
                canRetry: !submissionStarted,
                message: { title: _t("Printing Service"), body: message },
            };
        }
    },
});
