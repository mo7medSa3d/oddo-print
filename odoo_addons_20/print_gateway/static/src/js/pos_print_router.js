/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { gatewayServerMessage, showGatewayBillingLimitDialog } from "./gateway_limit_dialog";
import { isGatewayTimeoutError, withGatewayDeadline } from "./async_control";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { PosTicketPrinterPlugin } from "@point_of_sale/app/plugins/pos_ticket_printer_plugin";
import { renderGatewayReceiptJpeg } from "./receipt_raster";
import { RetryPrintPopup } from "@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup";
import { printRecoveryKey, claimPrintOperation, finishPrintOperation, gatewayOperationUuid, pollQueuedPrintJob } from "./operation_recovery";

const gatewayUuid = () => gatewayOperationUuid(_t("Secure random number generator is unavailable; cannot generate print operation idempotency key"));

const POS_RPC_TIMEOUT_MS = 20000;
const POS_RENDER_TIMEOUT_MS = 15000;
const POS_SYNC_TIMEOUT_MS = 20000;
const MAX_RETAINED_RECEIPT_OPS = 50;

const EXPLICITLY_UNKNOWN_CODES = new Set([
    "UNKNOWN_SUBMISSION_OUTCOME", "UNKNOWN_PARTIAL_DELIVERY",
    "AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT",
    "JOB_EXPIRED_DURING_PRINT",
]);
const TERMINAL_RECEIPT_STATUSES = new Set(["submitted", "claimed", "printing", "success", "failed"]);
const ACCEPTED_PRINT_STATUSES = new Set(["queued", "submitted", "claimed", "printing", "success"]);

function rememberReceiptOperation(receiptOps, key, entry) {
    receiptOps.delete(key);
    receiptOps.set(key, entry);
    while (receiptOps.size > MAX_RETAINED_RECEIPT_OPS) {
        const oldestKey = receiptOps.keys().next().value;
        receiptOps.delete(oldestKey);
    }
}

function isPreDispatchLicenseOrVerificationError(error) {
    const raw = String(
        error?.data?.message || error?.message || error?.data?.code || ""
    ).toLowerCase();
    return (
        raw.includes("license")
        || raw.includes("licence")
        || raw.includes("verification")
        || raw.includes("gateway_billing_limit")
        || raw.includes("entitlement")
    );
}

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
        // Best-effort diagnostics must never affect print behavior.
    }
}

function gatewayDataCall(plugin, model, method, args, kwargs = {}, { ambiguous = false } = {}) {
    // Odoo 20 PosDataPlugin.call(model, method, args, kwargs, queue=false):
    // always pass queue=false so printing RPCs run live instead of queuing offline.
    return withGatewayDeadline(
        () => plugin.data.call(model, method, args, kwargs, false),
        POS_RPC_TIMEOUT_MS,
        _t("Printing service request timed out."),
        { ambiguous },
    ).then((result) => {
        if (method === "is_gateway_printing_enabled" && typeof result !== "boolean") {
            throw new Error(_t("The printing service returned an invalid activation state. No print was sent."));
        }
        return result;
    });
}

function gatewaySync(posStore, options) {
    if (!posStore || typeof posStore.syncAllOrders !== "function") {
        return Promise.resolve();
    }
    return withGatewayDeadline(
        () => posStore.syncAllOrders(options),
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

async function renderIframeJpeg(plugin, template, data, geometry) {
    const renderStartedAt = globalThis.performance?.now?.() ?? Date.now();
    let iframe = null;
    try {
        iframe = await plugin.generateIframe(template, data);
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        const iframeEl = doc?.getElementById("pos-receipt");
        if (!iframeEl) {
            throw new Error(_t("Unable to locate the rendered POS receipt container."));
        }
        return await renderGatewayReceiptJpeg(iframeEl, { geometry });
    } finally {
        try {
            iframe?.remove();
        } catch {
            // Ignore cleanup errors on already-disposed frames.
        }
        recordReceiptLatency("pos_receipt_render", renderStartedAt);
    }
}

async function gatewayReceiptGeometry(plugin, orderId) {
    const lookupStartedAt = globalThis.performance?.now?.() ?? Date.now();
    try {
        return await gatewayDataCall(
            plugin, "pos.order", "get_gateway_receipt_geometry", [[orderId]], {},
        );
    } finally {
        recordReceiptLatency("pos_receipt_geometry", lookupStartedAt);
    }
}

function pluginEnv(plugin) {
    return plugin.env || plugin._gatewayPosStore?.env || {
        services: {
            notification: plugin.notification,
            dialog: plugin.dialog,
        },
    };
}

function kitchenTicketKey(ticket) {
    try {
        return JSON.stringify({
            title: ticket?.changes?.title || "",
            lines: (ticket?.changes?.data || []).map((line) => ({
                uuid: line.uuid || "",
                qty: line.quantity,
                note: line.note || "",
                name: line.basic_name || line.full_product_name || "",
            })),
        });
    } catch {
        return String(ticket?.changes?.title || "kitchen");
    }
}

patch(PosStore.prototype, {
    async setup(env, deps) {
        const res = await super.setup(env, deps);
        if (this.ticketPrinter) {
            this.ticketPrinter._gatewayPosStore = this;
        }
        return res;
    },

    async sendOrderInPreparation(order, opts = {}) {
        if (this.ticketPrinter && !this.ticketPrinter._gatewayPosStore) {
            this.ticketPrinter._gatewayPosStore = this;
        }
        return super.sendOrderInPreparation(order, opts);
    },
});

patch(PosTicketPrinterPlugin.prototype, {
    async printOrderReceipt({
        order,
        basic = false,
        printBillActionTriggered = false,
        webFallback = true,
        simplified = false,
    } = {}) {
        const currentOrder = order || this._gatewayPosStore?.getOrder?.();
        if (!currentOrder) {
            this.notification.add(_t("No active POS order is available to print."), { type: "warning" });
            return false;
        }

        const pendingReceipts = (this.gatewayPendingReceipts ||= new Set());
        const pendingKey = `${currentOrder.id || currentOrder.uuid || "order"}:${basic ? "1" : "0"}:${simplified ? "1" : "0"}`;
        if (pendingReceipts.has(pendingKey)) {
            return false;
        }
        pendingReceipts.add(pendingKey);
        let submissionAttempted = false;
        let activePrintClaim = null;
        const posStore = this._gatewayPosStore || null;
        try {
            let gatewayEnabled;
            const sessionId = this.session?.id;
            try {
                if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
                    this.notification.add(_t("Open a POS session before printing."), { type: "danger", sticky: true });
                    return false;
                }
                gatewayEnabled = await gatewayDataCall(
                    this, "pos.session", "is_gateway_printing_enabled", [[sessionId]],
                );
            } catch (probeError) {
                console.warn("POS print service check failed; falling back to native POS receipt printing:", probeError);
                return super.printOrderReceipt({ order: currentOrder, basic, printBillActionTriggered, webFallback, simplified });
            }

            if (gatewayEnabled !== true) {
                return super.printOrderReceipt({ order: currentOrder, basic, printBillActionTriggered, webFallback, simplified });
            }

            if (!currentOrder.isSynced || !Number.isInteger(currentOrder.id) || currentOrder.id <= 0) {
                try {
                    await gatewaySync(posStore, { orders: [currentOrder], force: false, throw: false });
                } catch (syncErr) {
                    console.warn("POS order sync before receipt print failed:", syncErr);
                }
            }
            const orderId = currentOrder.id;
            if (!Number.isInteger(orderId) || orderId <= 0) {
                console.warn("POS order is not yet synced; degrading gracefully to native POS receipt printing:", currentOrder.uuid || currentOrder.name);
                return super.printOrderReceipt({ order: currentOrder, basic, printBillActionTriggered, webFallback, simplified });
            }

            const receiptOps = (this.gatewayReceiptOperations ||= new Map());
            const opScopeKey = `${orderId}:${basic ? "b" : "f"}:${simplified ? "s" : "n"}`;
            const lastOp = receiptOps.get(opScopeKey);
            const memoryRetry = Boolean(lastOp?.terminal === false && lastOp?.image);
            const companyId = this.config?.company_id?.id || posStore?.company?.id || 0;
            const recoveryKey = printRecoveryKey("receipt", [
                companyId, sessionId, this.config?.id || 0,
                orderId, currentOrder.uuid || "", basic ? "basic" : simplified ? "simplified" : "full",
            ]);
            const claim = await claimPrintOperation(
                recoveryKey, memoryRetry ? lastOp.id : null, memoryRetry, gatewayUuid,
            );
            if (claim.blocked) {
                this.notification.add(
                    _t("An earlier receipt print is unresolved after this page changed. Check Print Activity and the printer. To print another copy, use the explicit reprint action in Print Activity."),
                    { type: "warning", sticky: true },
                );
                return false;
            }
            activePrintClaim = { recoveryKey, id: claim.id, newIntent: claim.newIntent, opScopeKey };
            const operationId = claim.id;
            let image = memoryRetry ? lastOp.image : undefined;
            let geometryFingerprint = memoryRetry ? lastOp.geometryFingerprint : undefined;
            if (!memoryRetry) {
                const geometry = await gatewayReceiptGeometry(this, orderId);
                const receiptData = this.getOrderReceiptData(currentOrder, { basic, simplified });
                image = await gatewayRender(() =>
                    renderIframeJpeg(this, "point_of_sale.pos_order_receipt", receiptData, geometry)
                );
                geometryFingerprint = geometry.config_fingerprint;
            }
            rememberReceiptOperation(receiptOps, opScopeKey, {
                id: operationId,
                image,
                geometryFingerprint,
                terminal: false,
                at: Date.now(),
                counted: Boolean(lastOp?.id === operationId && lastOp.counted),
            });
            submissionAttempted = true;
            const result = await gatewayDataCall(
                this,
                "pos.order",
                "action_print_gateway_receipt",
                [[orderId]],
                { image, operation_id: operationId, geometry_fingerprint: geometryFingerprint },
                { ambiguous: true },
            );

            const observedStatus = result?.gateway_enabled === true ? result?.status : "unknown";
            const explicitlyUnknownCode = EXPLICITLY_UNKNOWN_CODES.has(result?.code);
            let status = observedStatus === "failed" &&
                (result?.can_retry !== true || explicitlyUnknownCode)
                ? "unknown" : observedStatus;
            let liveError = null;
            if (status === "queued") {
                const live = await pollQueuedPrintJob(pluginEnv(this)?.services?.orm, result?.job_id);
                if (live) {
                    liveError = live.error;
                    status = live.status === "failed" &&
                        (result?.can_retry === false || explicitlyUnknownCode)
                        ? "unknown" : live.status;
                }
            }
            const terminal = TERMINAL_RECEIPT_STATUSES.has(status);
            if (terminal) {
                finishPrintOperation(recoveryKey, operationId);
            }
            rememberReceiptOperation(receiptOps, opScopeKey, {
                id: operationId,
                image: terminal ? undefined : image,
                geometryFingerprint: terminal ? undefined : geometryFingerprint,
                at: Date.now(),
                terminal,
                counted: lastOp?.id === operationId && lastOp.counted,
            });

            const safeFailure = gatewayServerMessage({
                data: { code: result?.code, message: result?.message || liveError },
            }) || _t("Couldn't print the receipt. See Print Activity.");
            const recordPrintAttempt = ACCEPTED_PRINT_STATUSES.has(status);
            if (status === "unknown" || status === "partial") {
                this.notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true }
                );
            } else if (status === "failed") {
                this.notification.add(safeFailure, { type: "danger" });
            } else if (recordPrintAttempt) {
                this.notification.add(
                    _t("Receipt accepted by the printing service. Paper output is not confirmed."),
                    { type: "info" }
                );
            } else {
                this.notification.add(
                    _t("Couldn't print the receipt. See Print Activity."),
                    { type: "danger" }
                );
            }

            if (!printBillActionTriggered && recordPrintAttempt && !receiptOps.get(opScopeKey)?.counted) {
                try {
                    await this.markReceiptAsPrinted(currentOrder);
                    const countedOperation = receiptOps.get(opScopeKey);
                    if (countedOperation?.id === operationId) {
                        countedOperation.counted = true;
                    }
                } catch (writeErr) {
                    console.warn("Failed to record receipt print count:", writeErr);
                }
            }
            return recordPrintAttempt;
        } catch (error) {
            const preDispatchFailure = !submissionAttempted || isPreDispatchLicenseOrVerificationError(error);
            if (activePrintClaim && preDispatchFailure && activePrintClaim.newIntent) {
                finishPrintOperation(activePrintClaim.recoveryKey, activePrintClaim.id);
                const saved = this.gatewayReceiptOperations?.get(activePrintClaim.opScopeKey);
                if (saved?.id === activePrintClaim.id) {
                    this.gatewayReceiptOperations.delete(activePrintClaim.opScopeKey);
                }
            }
            if (preDispatchFailure) {
                console.warn("POS direct receipt dispatch degraded gracefully to native POS printing:", error?.message || error, error);
                return super.printOrderReceipt({ order: currentOrder, basic, printBillActionTriggered, webFallback, simplified });
            }
            if (showGatewayBillingLimitDialog(pluginEnv(this), error)) {
                return false;
            }
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

    async printOrderChanges({
        order,
        opts = {},
        printers = this.config?.preparation_printer_ids || [],
        retryChanges = new Map(),
    } = {}) {
        const sessionId = this.session?.id;
        let gatewayEnabled;
        try {
            if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
                this.notification.add(_t("Open a POS session before printing."), { type: "danger", sticky: true });
                return false;
            }
            gatewayEnabled = await gatewayDataCall(
                this, "pos.session", "is_gateway_printing_enabled", [[sessionId]],
            );
        } catch (error) {
            console.warn("POS kitchen print service check failed; falling back to native printOrderChanges:", error);
            return super.printOrderChanges({ order, opts, printers, retryChanges });
        }

        if (gatewayEnabled !== true) {
            return super.printOrderChanges({ order, opts, printers, retryChanges });
        }

        const posStore = this._gatewayPosStore || null;
        try {
            if (!order?.isSynced || !Number.isInteger(order?.id) || order.id <= 0) {
                await gatewaySync(posStore, { orders: [order], force: true, throw: true });
            }
        } catch (error) {
            console.warn("POS order sync failed in printOrderChanges; degrading to native printOrderChanges:", error);
            return super.printOrderChanges({ order, opts, printers, retryChanges });
        }

        const orderId = order?.id;
        if (!Number.isInteger(orderId) || orderId <= 0) {
            console.warn("POS order has no server id in printOrderChanges; degrading to native printOrderChanges.");
            return super.printOrderChanges({ order, opts, printers, retryChanges });
        }

        let activeKitchenClaim = null;
        let kitchenDispatchStarted = false;
        try {
            const kitchenRoutes = await gatewayDataCall(
                this, "pos.order", "get_gateway_kitchen_routes", [[orderId]], {},
            );
            if (!kitchenRoutes || !Array.isArray(kitchenRoutes.routes)) {
                this.notification.add(_t("Gateway returned an invalid kitchen-routing configuration."), { type: "danger", sticky: true });
                return false;
            }

            const missingRoutes = Array.isArray(kitchenRoutes.missing_routes) ? kitchenRoutes.missing_routes : [];
            const isRetryAttempt = retryChanges instanceof Map && retryChanges.size > 0;
            const requestedPrinterIds = isRetryAttempt
                ? new Set(Array.from(printers || []).map((p) => p?.id).filter(Boolean))
                : null;
            const routes = requestedPrinterIds
                ? kitchenRoutes.routes.filter((r) => requestedPrinterIds.has(r.pos_printer_id))
                : kitchenRoutes.routes;

            if (missingRoutes.length && !isRetryAttempt) {
                const probeChange = order.getChanges?.({ cancelled: opts.cancelled }) || {};
                const changedCategoryIds = new Set();
                for (const key of ["addedQuantity", "removedQuantity", "noteUpdate"]) {
                    for (const line of probeChange[key] || []) {
                        const product = this.data.models["product.product"].get(line.product_id);
                        for (const catId of product?.parentPosCategIds || []) {
                            changedCategoryIds.add(catId);
                        }
                    }
                }
                const uncovered = missingRoutes.filter((route) =>
                    (route.category_ids || []).some((catId) => changedCategoryIds.has(catId))
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
                    _t("Gateway printing is enabled for this POS, but no Gateway Kitchen binding is configured for an Odoo preparation printer."),
                    { type: "danger", sticky: true }
                );
                return false;
            }

            const prepPrinters = this.config?.preparation_printer_ids || [];
            const printerById = new Map(
                Array.from(printers || prepPrinters).filter((p) => p?.id).map((p) => [p.id, p])
            );

            const companyId = this.config?.company_id?.id || posStore?.company?.id || 0;
            const baseBatchKey = gatewayUuid();
            const failedPrinters = [];
            const failedChanges = new Map();
            const unsuccessfulPrints = [];
            let isPrinted = false;

            for (const route of routes) {
                const printer = printerById.get(route.pos_printer_id) || null;
                const categoryIds = new Set(
                    Array.isArray(route.category_ids) && route.category_ids.length
                        ? route.category_ids
                        : Array.from(this.config?.printerCategories || [])
                );
                const generator = this.getGenerator({ models: this.data.models, order });
                const printerOpts = printer && retryChanges.has(printer)
                    ? { ...opts, orderChange: retryChanges.get(printer) }
                    : opts;
                const changes = generator.generatePreparationData(categoryIds, printerOpts);
                const template = opts.template || "point_of_sale.pos_order_change_receipt";

                for (let ticketIndex = 0; ticketIndex < changes.length; ticketIndex++) {
                    const ticket = changes[ticketIndex];
                    if (ticket?.extra_data?.reprint && !opts.explicitReprint) {
                        continue;
                    }
                    const reprint = Boolean(ticket?.extra_data?.reprint || opts.explicitReprint);
                    const recoveryKey = printRecoveryKey("kitchen-ticket", [
                        companyId, sessionId, this.config?.id || 0,
                        orderId, order.uuid || "", route.pos_printer_id || "pos",
                        ticketIndex, kitchenTicketKey(ticket),
                    ]);
                    const opId = reprint ? "kitchen-reprint-" + gatewayUuid() : `${baseBatchKey}:${route.pos_printer_id || "pos"}:${ticketIndex}`;
                    const claim = await claimPrintOperation(recoveryKey, opId, false, () => opId);
                    if (claim.blocked) {
                        this.notification.add(
                            _t("An earlier kitchen print is unresolved. Check Print Activity and the printer before continuing."),
                            { type: "warning", sticky: true },
                        );
                        continue;
                    }
                    activeKitchenClaim = { recoveryKey, id: claim.id, newIntent: claim.newIntent };
                    let submissionStarted = false;
                    try {
                        const image = await gatewayRender(() =>
                            renderIframeJpeg(this, template, ticket, route.geometry)
                        );
                        submissionStarted = true;
                        kitchenDispatchStarted = true;
                        const result = await gatewayDataCall(
                            this,
                            "pos.order",
                            "action_print_gateway_kitchen",
                            [[orderId]],
                            {
                                image,
                                geometry_fingerprint: route.geometry.config_fingerprint,
                                reprint,
                                operation_id: claim.id,
                                pos_printer_id: route.pos_printer_id || undefined,
                            },
                            { ambiguous: true },
                        );
                        const status = result?.gateway_enabled === true ? result?.status : "unknown";
                        const accepted = ACCEPTED_PRINT_STATUSES.has(status);
                        const provenFailure = status === "failed" && result?.can_retry === true;
                        if (accepted || provenFailure) {
                            finishPrintOperation(recoveryKey, claim.id);
                        }
                        if (accepted) {
                            isPrinted = true;
                        } else {
                            if (printer && provenFailure) {
                                failedPrinters.push(printer);
                                failedChanges.set(printer, ticket._rawChange);
                            }
                            const msg = gatewayServerMessage({ data: { code: result?.code, message: result?.message } })
                                || _t("Kitchen / Preparation printing failed.");
                            unsuccessfulPrints.push((printer?.name ? printer.name + ": " : "") + msg);
                        }
                    } catch (err) {
                        if (!submissionStarted && claim.newIntent) {
                            finishPrintOperation(recoveryKey, claim.id);
                        }
                        if (showGatewayBillingLimitDialog(pluginEnv(this), err)) {
                            return false;
                        }
                        unsuccessfulPrints.push(gatewayServerMessage(err) || _t("Kitchen / Preparation printing failed."));
                    }
                }
            }

            if (unsuccessfulPrints.length) {
                this.showPrinterErrorDialog(
                    { title: _t("Printing failed"), body: unsuccessfulPrints.join("\n") },
                    () => this.printOrderChanges({
                        order,
                        opts,
                        printers: failedPrinters.length ? failedPrinters : printers,
                        retryChanges: failedChanges,
                    }),
                    !opts.skipRetry && failedPrinters.length > 0,
                );
            }
            return isPrinted;
        } catch (error) {
            if (activeKitchenClaim?.newIntent && !kitchenDispatchStarted) {
                finishPrintOperation(activeKitchenClaim.recoveryKey, activeKitchenClaim.id);
            }
            if (showGatewayBillingLimitDialog(pluginEnv(this), error)) {
                return false;
            }
            this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), {
                type: "danger",
            });
            return false;
        }
    },
});
