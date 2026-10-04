/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { gatewayServerMessage, showGatewayBillingLimitDialog } from "./gateway_limit_dialog";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";
import { renderToElement } from "@web/core/utils/render";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";
import { toCanvas as htmlToImageToCanvas } from "@point_of_sale/app/utils/html-to-image";
import { waitImages } from "@point_of_sale/utils";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { RetryPrintPopup } from "@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup";

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

function canvasToJpeg(canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Strip any Data-URL prefix variant (some browsers emit charset/parameters);
    // the payload layer only accepts raw base64.
    return canvas.toDataURL("image/jpeg", 0.65).replace(/^data:image\/[a-z]+;base64,/, "");
}

async function elementToJpeg(element) {
    const canvas = await htmlToCanvas(element, { addClass: "pos-receipt-print" });
    return canvasToJpeg(canvas);
}

/**
 * Convert a rendered receipt element to JPEG WITHOUT web-font embedding.
 *
 * html-to-image's font embedding scans EVERY @font-face rule in the POS
 * document and fetches each one — including Odoo's Noto UI fonts whose
 * italic/Arabic/Hebrew variants are missing from fonts.odoocdn.com, which
 * produces the recurring console 404s. The receipt declares no custom font
 * (Bootstrap utilities only), so embedding is pure overhead: text renders
 * with locally available fonts instead.
 *
 * Odoo's render_service.htmlToCanvas builds a fixed option object and drops
 * every other option, so skipFonts cannot flow through renderer.toJpeg /
 * renderer.toCanvas. This helper calls Odoo's vendored html-to-image build
 * directly with the same snapshot options Odoo uses plus skipFonts: true.
 */
async function elementToJpegNoFonts(element) {
    if (!element) {
        throw new Error(_t("No receipt element to rasterize"));
    }
    try {
        element.classList.add("pos-receipt-print");
    } catch {
        // Detached or exotic node: the class is a styling hook only.
    }
    // waitImages is timeout-safe and resolves on error; QR/logo <img>
    // embedding below is independent of fonts and still applies.
    await waitImages(element);
    const canvas = await htmlToImageToCanvas(element, {
        backgroundColor: "#ffffff",
        pixelRatio: 1,
        includeQueryParams: true,
        skipFonts: true,
    });
    return canvasToJpeg(canvas);
}

export async function renderReceiptImage(pos, currentOrder, basic = false) {
    const renderer = pos.env?.services?.renderer || pos.printer?.renderer;
    const props = {
        order: currentOrder,
        basic_receipt: Boolean(basic),
    };

    const receiptComponent = pos.orderReceiptComponent || OrderReceipt;

    if (renderer && typeof renderer.toHtml === "function") {
        try {
            // Preferred path: toHtml is pure Owl rendering (no font
            // involvement); rasterize with web-font embedding disabled so no
            // remote Noto variant is ever requested (see elementToJpegNoFonts).
            const element = await renderer.toHtml(receiptComponent, props);
            return await elementToJpegNoFonts(element);
        } catch (err) {
            console.warn("renderer.toHtml (no-fonts) failed, falling back to standard chain:", err);
        }
    }

    if (renderer && typeof renderer.toJpeg === "function") {
        try {
            return await renderer.toJpeg(receiptComponent, props, { addClass: "pos-receipt-print" });
        } catch (err) {
            console.warn("renderer.toJpeg failed, falling back to toCanvas/toHtml:", err);
        }
    }

    if (renderer && typeof renderer.toCanvas === "function") {
        try {
            const canvas = await renderer.toCanvas(receiptComponent, props, { addClass: "pos-receipt-print" });
            return canvasToJpeg(canvas);
        } catch (err) {
            console.warn("renderer.toCanvas failed, falling back to toHtml:", err);
        }
    }

    if (renderer && typeof renderer.toHtml === "function") {
        try {
            const element = await renderer.toHtml(receiptComponent, props);
            return await elementToJpeg(element);
        } catch (err) {
            console.warn("renderer.toHtml failed, falling back to renderToElement:", err);
        }
    }

    // Direct template fallback if renderer service is unavailable:
    const receipt = renderToElement(receiptComponent.template || "point_of_sale.OrderReceipt", props);
    return await elementToJpeg(receipt);
}

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        if (!currentOrder) {
            this.notification.add(_t("No POS order is available for printing."), { type: "danger" });
            return false;
        }

        try {
            const sessionId = this.session?.id;
            const gatewayEnabled = sessionId
                ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                : false;

            if (gatewayEnabled !== true) {
                return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
            }

            // The Gateway path requires a persisted server-side order id; synchronize an unsynced order
            // before rendering/submitting so the print request has a durable Odoo record.
            if (!currentOrder.isSynced) {
                try {
                    await this.syncAllOrders({ orders: [currentOrder], force: false, throw: false });
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

            const image = await renderReceiptImage(this, currentOrder, basic);
            const result = await this.data.call(
                "pos.order",
                "action_print_gateway_receipt",
                [[orderId]],
                { image },
                true
            );

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
            if (!printBillActionTriggered && recordPrintAttempt) {
                const count = currentOrder.nb_print ? currentOrder.nb_print + 1 : 1;
                try {
                    const writeResult = await this.data.silentCall(
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
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return false;
            }
            // Fail-safe: display user notification and return false, NEVER re-throw to avoid freezing POS UI.
            // Read the server-side message (error.data.message), not the
            // generic RPC title (error.message is "Odoo Server Error" for
            // every deterministic printer failure).
            this.notification.add(gatewayServerMessage(error) || _t("Receipt printing failed."), { type: "danger" });
            return false;
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
        const sessionId = this.session?.id;
        let gatewayEnabled;
        try {
            gatewayEnabled = sessionId
                ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                : false;
        } catch (error) {
            this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
            return false;
        }
        if (gatewayEnabled !== true) {
            return super.sendOrderInPreparation(order, opts);
        }

        let isPrinted = false;
        let hasChanges = false;
        try {
            this.syncingOrders.add(order.uuid);

            if (!opts.byPassPrint) {
                let reprint = false;

                // Odoo 19 defines the preparation scope from native
                // pos.printer.product_categories_ids. Gateway changes only the
                // physical destination; it must not expand the business scope
                // to every product category loaded in the POS.
                const gatewayCategories = this.config.printerCategories;
                let orderChange = changesToOrder(order, gatewayCategories, opts.cancelled);
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
                    isPrinted = await this.printChanges(order, orderChange, reprint);
                }
            }

            // Preserve the Odoo 19 core order-change lifecycle:
            // consume the preparation change only after a Gateway print is
            // accepted, or when there is no preparation printer to print to.
            if (isPrinted) {
                order.updateLastOrderChange();
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
            await this.syncAllOrders({ orders: [order] });
        }

        return isPrinted;
    },

    async printChanges(
        order,
        orderChange,
        reprint = false,
        printers = this.unwatched.printers
    ) {
        const sessionId = this.session?.id;
        let gatewayEnabled;
        try {
            gatewayEnabled = sessionId
                ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                : false;
        } catch (error) {
            this.notification.add(gatewayServerMessage(error) || _t("Kitchen / Preparation printing failed."), { type: "danger" });
            return false;
        }
        if (gatewayEnabled !== true) {
            return super.printChanges(order, orderChange, reprint, printers);
        }

        try {
            if (!order?.isSynced || !Number.isInteger(order?.id)) {
                await this.syncAllOrders({ orders: [order], force: false, throw: true });
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
            const kitchenRoutes = await this.data.call(
                "pos.order",
                "get_gateway_kitchen_routes",
                [[orderId]],
                {},
                true
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
                            retryAttempt
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
                    retry: async () => {
                        const accepted = await this.printChanges(order, orderChange, reprint, retryPrinters);
                        if (accepted && !reprint) {
                            order.updateLastOrderChange();
                            order.uiState.gatewayKitchenAttempts = {};
                            order.uiState.gatewayKitchenPendingKeys = [];
                            order.uiState.gatewayKitchenOperationIds = {};
                        }
                        return accepted;
                    },
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
    },
    async printOrderChanges(data, printer, posPrinterId = null, isRetry = false) {
        const orderId = data?.orderData?.__gateway_order_id;
        const sessionId = data?.orderData?.__gateway_session_id;
        const reprint = Boolean(data?.orderData?.__gateway_reprint);
        const operationId = data?.orderData?.__gateway_print_id;
        const requestOperationId = operationId;

        let gatewayEnabled;
        try {
            gatewayEnabled = sessionId
                ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
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

        try {
            const receipt = renderToElement("point_of_sale.OrderChangeReceipt", { data });
            const image = await elementToJpeg(receipt);
            const result = await this.data.call(
                "pos.order",
                "action_print_gateway_kitchen",
                [[orderId]],
                {
                    image,
                    reprint,
                    operation_id: requestOperationId,
                    pos_printer_id: posPrinterId || undefined,
                },
                true
            );
            const status = result?.status;
            if (["unknown", "partial"].includes(status)) {
                return {
                    successful: false,
                    gatewayOutcome: status,
                    canRetry: false,
                    warningCode: undefined,
                    message: {
                        title: _t("Printing Service"),
                        body: status === "unknown"
                            ? _t("Kitchen print outcome is unknown. The ticket may already have printed; automatic retry is disabled.")
                            : _t("Kitchen print status is unclear. Automatic retry is paused to prevent duplicate tickets."),
                    },
                };
            }
            return {
                successful: ["queued", "submitted", "claimed", "printing", "success"].includes(status),
                warningCode: undefined,
                gatewayOutcome: status,
            };
        } catch (error) {
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return {
                    successful: false,
                    canRetry: false,
                    message: { title: _t("Printing Service"), body: _t("The Gateway plan limit has been reached.") },
                };
            }
            const message = gatewayServerMessage(error) || _t("Kitchen print outcome is unknown. The ticket may already have printed; automatic retry is disabled.");
            this.notification.add(message, { type: "warning", sticky: true });
            return {
                successful: false,
                gatewayOutcome: "unknown",
                canRetry: false,
                message: { title: _t("Printing Service"), body: message },
            };
        }
    },
});
