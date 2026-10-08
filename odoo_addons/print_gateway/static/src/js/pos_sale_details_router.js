/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { gatewayServerMessage, showGatewayBillingLimitDialog } from "./gateway_limit_dialog";
import { formatDateTime } from "@web/core/l10n/dates";
import { withGatewayDeadline } from "./async_control";

// `@web/core/l10n/dates` does not export DateTime in Odoo 19 (it reads the
// luxon global privately). Take DateTime from the same global, mirroring
// core's own `const { DateTime, Settings } = luxon;` idiom.
const { DateTime } = luxon;
import { SaleDetailsButton } from "@point_of_sale/app/components/navbar/sale_details_button/sale_details_button";
import { renderToElement } from "@web/core/utils/render";
import { renderGatewayReceiptJpeg } from "./receipt_raster";

function gatewayDataCall(pos, model, method, args, kwargs = {}, silent = true, { ambiguous = false } = {}) {
    return withGatewayDeadline(
        () => pos.data.call(model, method, args, kwargs, silent),
        20000,
        _t("Printing service request timed out."),
        { ambiguous },
    );
}

// Secure per-click operation identity (mirrors gatewayUuid in
// pos_print_router.js): lost-response retries reuse the id, deliberate
// later prints mint a fresh one. Fail closed when no secure RNG exists so
// distinct operations can never collapse into one idempotency key.
function gatewayOperationUuid() {
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

patch(SaleDetailsButton.prototype, {
    async onClick() {
        const sessionId = this.pos.session?.id;
        if (!sessionId) {
            return super.onClick();
        }

        // Guard the entire click, including metadata and image rendering.
        if (this.pos.gatewaySaleDetailsPending) {
            return false;
        }
        this.pos.gatewaySaleDetailsPending = true;
        try {
            const enabled = await gatewayDataCall(this.pos,
                "pos.session",
                "is_gateway_printing_enabled",
                [[sessionId]],
                {},
                true
            );
            if (enabled !== true) {
                return super.onClick();
            }

            // One operation identity per user click with cached payload for
            // uncertain retries: the render embeds the current timestamp, so
            // a retry must resend the IDENTICAL bytes (same id + same image)
            // or the server rejects it as a conflicting operation. A reuse
            // applies only while the previous outcome is uncertain and recent
            // (5 minutes); accepted/definitively-failed outcomes and older
            // operations mint a fresh id with a fresh render.
            const saleDetailsOps = (this.pos.gatewaySaleDetailsOperations ||= new Map());
            for (const [key, op] of saleDetailsOps) {
                if (Date.now() - op.at >= 5 * 60 * 1000) saleDetailsOps.delete(key);
            }
            const lastOp = saleDetailsOps.get(sessionId);
            const reuseUncertain = lastOp && lastOp.terminal === false
                && (Date.now() - lastOp.at < 5 * 60 * 1000);
            let operationId;
            let image;
            if (reuseUncertain) {
                operationId = lastOp.id;
                image = lastOp.image;
            } else {
                operationId = gatewayOperationUuid();
                const saleDetails = await gatewayDataCall(
                    this.pos, "report.point_of_sale.report_saledetails",
                    "get_sale_details", [false, false, false, [sessionId]],
                );
                const report = renderToElement(
                    "point_of_sale.SaleDetailsReport",
                    Object.assign({}, saleDetails, {
                        date: formatDateTime(DateTime.now()),
                        pos: this.pos,
                        formatCurrency: this.pos.env.utils.formatCurrency,
                    })
                );
                let rasterWidth = 512;
                try {
                    rasterWidth = await gatewayDataCall(this.pos,
                        "pos.session", "get_gateway_sale_details_raster_width", [[sessionId]], {}, true,
                    );
                } catch (error) {
                    console.warn("Sale Details printer width unavailable, using native 512px:", error);
                }
                image = await withGatewayDeadline(
                    () => renderGatewayReceiptJpeg(report, {
                        renderer: this.env.services.renderer,
                        width: rasterWidth,
                    }),
                    15000,
                    _t("Receipt rendering timed out."),
                );
            }
            let result;
            try {
                result = await gatewayDataCall(
                    this.pos,
                    "pos.session",
                    "action_print_gateway_sale_details",
                    [[sessionId]],
                    { image, operation_id: operationId },
                    true,
                    { ambiguous: true },
                );
            } catch (rpcError) {
                saleDetailsOps.set(sessionId, { id: operationId, image, at: Date.now(), terminal: false });
                throw rpcError;
            }
            const terminal = ["queued", "submitted", "claimed", "printing", "success", "failed"].includes(result?.status);
            saleDetailsOps.set(sessionId, {
                id: operationId,
                image: terminal ? undefined : image,
                at: Date.now(),
                terminal,
            });
            if (!result?.gateway_enabled) {
                throw new Error(_t("Print Gateway returned an invalid Sale Details response."));
            }
            if (["unknown", "partial"].includes(result?.status)) {
                this.env.services.notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true }
                );
            } else if (["queued", "submitted", "claimed", "printing", "success"].includes(result?.status)) {
                this.env.services.notification.add(
                    result.message || _t("Sales Details sent to the printing service."),
                    { type: "success" }
                );
            }
            if (!["queued", "submitted", "claimed", "printing", "success"].includes(result?.status)) {
                if (!["unknown", "partial"].includes(result?.status)) {
                    this.env.services.notification.add(result?.message || _t("Sales Details could not be printed."), { type: "danger" });
                }
                return false;
            }
            return result;
        } catch (error) {
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return false;
            }
            // Fail-safe parity with the receipt router: notify once and
            // return false instead of re-throwing, so a Gateway failure
            // cannot freeze the Sale Details button with a double dialog.
            this.env.services.notification.add(gatewayServerMessage(error) || _t("Sales Details could not be printed."), { type: "danger" });
            return false;
        } finally {
            this.pos.gatewaySaleDetailsPending = false;
        }
    },
});
