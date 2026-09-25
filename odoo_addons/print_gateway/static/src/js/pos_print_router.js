/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { showGatewayBillingLimitDialog } from "./gateway_limit_dialog";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";
import { renderToElement } from "@web/core/utils/render";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { RetryPrintPopup } from "@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup";

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

async function renderReceiptImage(pos, currentOrder, basic = false) {
    const renderer = pos.env?.services?.renderer || pos.printer?.renderer;
    const props = {
        data: typeof currentOrder.export_for_printing === "function" ? currentOrder.export_for_printing() : currentOrder,
        order: currentOrder,
        formatCurrency: pos.env?.utils?.formatCurrency || pos.formatCurrency || ((amount) => String(amount)),
        basic_receipt: Boolean(basic),
    };

    if (renderer && typeof renderer.toJpeg === "function") {
        try {
            return await renderer.toJpeg(OrderReceipt, props, { addClass: "pos-receipt-print" });
        } catch (err) {
            console.warn("renderer.toJpeg failed, falling back to toCanvas/toHtml:", err);
        }
    }

    if (renderer && typeof renderer.toCanvas === "function") {
        try {
            const canvas = await renderer.toCanvas(OrderReceipt, props, { addClass: "pos-receipt-print" });
            return canvasToJpeg(canvas);
        } catch (err) {
            console.warn("renderer.toCanvas failed, falling back to toHtml:", err);
        }
    }

    if (renderer && typeof renderer.toHtml === "function") {
        try {
            const element = await renderer.toHtml(OrderReceipt, props);
            return await elementToJpeg(element);
        } catch (err) {
            console.warn("renderer.toHtml failed, falling back to renderToElement:", err);
        }
    }

    // Direct template fallback if renderer service is unavailable:
        const receipt = renderToElement("point_of_sale.pos_order_receipt", props);
    return await elementToJpeg(receipt);
}

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        if (!currentOrder) {
            this.notification.add("No POS order is available for printing.", { type: "danger" });
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
            if (!orderId) {
                console.warn("POS order has no server identifier; cannot print via Gateway without synced record:", currentOrder.uuid || currentOrder.name);
                this.notification.add("Sync the POS order before sending the receipt to the printing service.", { type: "warning" });
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
            // printed; "unknown" means the outcome cannot be trusted.
            if (["unknown", "partial"].includes(result?.status)) {
                this.notification.add(
                    "Print status is unknown. Check the printer before trying again.",
                    { type: "warning", sticky: true }
                );
            } else if (result?.status === "failed") {
                this.notification.add(
                    result?.message || "The receipt could not be accepted for printing. Check Print Activity for details.",
                    { type: "danger" }
                );
            } else {
                this.notification.add(
                    result?.message || "Receipt sent to the printing service. Check Print Activity for the final status.",
                    { type: "success" }
                );
            }

            // Count only accepted/known print outcomes. A definite Gateway
            // rejection or an ambiguous physical outcome must not be recorded
            // as a completed POS print.
            const recordPrintAttempt = !["failed", "unknown", "partial"].includes(result?.status);
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
            return result;
        } catch (error) {
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return false;
            }
            // Fail-safe: display user notification and return false, NEVER re-throw to avoid freezing POS UI
            this.notification.add(error?.message || "Receipt printing failed.", { type: "danger" });
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
            orderChange.__gateway_print_id = crypto.randomUUID();
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
        const gatewayEnabled = sessionId
            ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
            : false;
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

            // Preserve the Odoo 19 core order-change lifecycle. This method
            // exists on PosOrder; updateLastOrderChangeIfNoDevice() does not.
            order.updateLastOrderChange(opts);
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
        printers = this.models["pos.printer"].getAll()
    ) {
        const sessionId = this.session?.id;
        const gatewayEnabled = sessionId
            ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
            : false;
        if (gatewayEnabled !== true) {
            return super.printChanges(order, orderChange, reprint, printers);
        }

        const orderId = order?.id;
        if (!orderId) {
            const message = "The POS order is not synchronized yet, so kitchen printing cannot continue.";
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
                    "Gateway returned an invalid kitchen-routing configuration.",
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
                        "Gateway Kitchen routing is incomplete for one or more Odoo Preparation Printers. Printing was cancelled to prevent silently losing kitchen tickets.",
                        { type: "danger", sticky: true }
                    );
                    return false;
                }
            }

            if (!routes.length) {
                this.notification.add(
                    retryAttempt
                        ? "The previously failed kitchen printer is no longer available in the current POS configuration."
                        : "Gateway printing is enabled for this POS, but no Gateway Kitchen binding is configured for an Odoo preparation printer.",
                    { type: "danger", sticky: true }
                );
                return false;
            }

            let isPrinted = false;
            const unsuccessfulPrints = [];
            const retryPrinters = new Set();
            const printerById = new Map(
                Array.from(printers || [])
                    .filter((printer) => printer?.id)
                    .map((printer) => [printer.id, printer])
            );

            for (const route of routes) {
                const routeCategories = Array.isArray(route.category_ids) ? route.category_ids : [];

                for (const change of orderChange) {
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
                        const baseOperation = retryAttempt
                            ? crypto.randomUUID()
                            : data?.orderData?.__gateway_print_id;
                        if (baseOperation) {
                            data.orderData.__gateway_print_id =
                                baseOperation + ":" +
                                String(route.pos_printer_id || "pos") + ":" +
                                String(index);
                        }
                    });

                    for (const data of receiptsData) {
                        const printer = printerById.get(route.pos_printer_id);
                        const result = await this.printOrderChanges(
                            data,
                            printer,
                            route.pos_printer_id || null,
                            retryAttempt
                        );

                        if (result?.gatewayOutcome === "unknown" || result?.gatewayOutcome === "partial") {
                            this.notification.add(
                                result.message?.body ||
                                    "Kitchen print status is unknown. Check the printer before trying again.",
                                { type: "warning", sticky: true }
                            );
                            continue;
                        }

                        if (result.successful) {
                            isPrinted = true;
                        } else {
                            if (printer) {
                                retryPrinters.add(printer);
                            }
                            unsuccessfulPrints.push(
                                printer?.config?.name ||
                                    ("Odoo Preparation Printer " + String(route.pos_printer_id) + ": " +
                                        (result.message?.body || "print failed"))
                            );
                            if (result.message?.body && printer?.config?.name) {
                                unsuccessfulPrints[unsuccessfulPrints.length - 1] =
                                    printer.config.name + ": " + result.message.body;
                            }
                        }

                        if (result.successful && result.warningCode) {
                            this.displayPrinterWarning(
                                result,
                                printer?.config?.name || "Gateway Kitchen"
                            );
                        }
                    }
                }
            }

            if (!reprint && isPrinted && orderChange.length) {
                order.uiState.lastPrints.push(orderChange[0]);
            }

            if (unsuccessfulPrints.length && retryPrinters.size) {
                const failedReceipts = unsuccessfulPrints.join("\n");
                this.dialog.add(RetryPrintPopup, {
                    message: failedReceipts,
                    canRetry: true,
                    retry: () => {
                        this.printChanges(order, orderChange, reprint, retryPrinters);
                    },
                });
            }

            return isPrinted;
        } catch (error) {
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return false;
            }
            this.notification.add(error?.message || "Kitchen / Preparation printing failed.", {
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
        const requestOperationId = isRetry
            ? "kitchen-retry-" + crypto.randomUUID()
            : operationId;

        const gatewayEnabled = sessionId
            ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
            : false;
        if (gatewayEnabled !== true) {
            return super.printOrderChanges(data, printer);
        }
        if (!orderId) {
            const message = "The POS order is not synchronized yet, so kitchen printing cannot continue.";
            this.notification.add(message, { type: "danger" });
            return {
                successful: false,
                canRetry: true,
                message: { title: "Printing Service", body: message },
            };
        }

        try {
            const receipt = renderToElement("point_of_sale.pos_order_change_receipt", data);
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
                    warningCode: undefined,
                    message: {
                        title: "Printing Service",
                        body: status === "unknown"
                            ? "Kitchen print outcome is unknown. The ticket may already have printed; automatic retry is disabled."
                            : "Kitchen print status is unclear. Automatic retry is paused to prevent duplicate tickets.",
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
                    message: { title: "Printing Service", body: "The Gateway plan limit has been reached." },
                };
            }
            this.notification.add(error?.message || "Kitchen / Preparation printing failed.", { type: "danger" });
            return {
                successful: false,
                canRetry: true,
                message: { title: "Printing Service", body: error?.message || "Kitchen / Preparation printing failed." },
            };
        }
    },
});
