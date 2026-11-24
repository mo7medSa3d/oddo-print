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
import { printRecoveryKey, claimPrintOperation, finishPrintOperation } from "./operation_recovery";

function gatewayDataCall(pos, model, method, args, kwargs = {}, silent = true, { ambiguous = false } = {}) {
    return withGatewayDeadline(
        () => pos.data.call(model, method, args, kwargs, silent),
        20000,
        _t("Printing service request timed out."),
        { ambiguous },
    ).then((result) => {
        if (method === "is_gateway_printing_enabled" && typeof result !== "boolean") {
            throw new Error(_t("The printing service returned an invalid activation state. No print was sent."));
        }
        return result;
    });
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
        if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
            this.env.services.notification.add(_t("Open a POS session before printing."), { type: "danger", sticky: true });
            return false;
        }

        // Guard the entire click, including metadata and image rendering.
        if (this.pos.gatewaySaleDetailsPending) {
            return false;
        }
        this.pos.gatewaySaleDetailsPending = true;
        let submissionAttempted = false;
        let activePrintClaim = null;
        try {
            let enabled = false;
            try {
                enabled = await gatewayDataCall(this.pos,
                    "pos.session",
                    "is_gateway_printing_enabled",
                    [[sessionId]],
                    {},
                    true
                );
            } catch (probeError) {
                console.warn("POS Sale Details service check failed; falling back to native printing:", probeError);
                return super.onClick();
            }
            if (enabled !== true) {
                return super.onClick();
            }

            // A browser reload does not retain the rendered Sale Details bytes
            // (the report includes a timestamp). Persist the operation key,
            // not the confidential image. Block a fresh print if a prior
            // unknown operation exists without its original live payload.
            const saleDetailsOps = (this.pos.gatewaySaleDetailsOperations ||= new Map());
            const lastOp = saleDetailsOps.get(sessionId);
            const memoryRetry = Boolean(lastOp?.terminal === false && lastOp?.image);
            const recoveryKey = printRecoveryKey("sale-details", [
                this.pos.env?.services?.user?.userId || this.pos.user?.id || 0,
                this.pos.company?.id || this.pos.env?.services?.company?.currentCompany?.id || 0,
                sessionId, this.pos.config?.id || 0,
            ]);
            const claim = await claimPrintOperation(recoveryKey, memoryRetry ? lastOp.id : null,
                memoryRetry, gatewayOperationUuid);
            if (claim.blocked) {
                this.env.services.notification.add(
                    _t("An earlier Sales Details print is unresolved after this page changed. Check Print Activity and the printer. Use the explicit reprint action in Print Activity if another paper copy is needed."),
                    { type: "warning", sticky: true },
                );
                return false;
            }
            activePrintClaim = { recoveryKey, id: claim.id, newIntent: claim.newIntent };
            let operationId = claim.id;
            let image = memoryRetry ? lastOp.image : undefined;
            let geometryFingerprint = memoryRetry ? lastOp.geometryFingerprint : undefined;
            if (!memoryRetry) {
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
                const geometry = await gatewayDataCall(this.pos,
                    "pos.session", "get_gateway_sale_details_geometry", [[sessionId]], {}, true,
                );
                image = await withGatewayDeadline(
                    () => renderGatewayReceiptJpeg(report, {
                        renderer: this.env.services.renderer,
                        geometry,
                    }),
                    15000,
                    _t("Receipt rendering timed out."),
                );
                geometryFingerprint = geometry.config_fingerprint;
            }
            saleDetailsOps.set(sessionId, { id: operationId, image, geometryFingerprint, terminal: false, at: Date.now() });
            let result;
            try {
                submissionAttempted = true;
                result = await gatewayDataCall(
                    this.pos,
                    "pos.session",
                    "action_print_gateway_sale_details",
                    [[sessionId]],
                    { image, operation_id: operationId, geometry_fingerprint: geometryFingerprint },
                    true,
                    { ambiguous: true },
                );
            } catch (rpcError) {
                saleDetailsOps.set(sessionId, { id: operationId, image, geometryFingerprint, at: Date.now(), terminal: false });
                throw rpcError;
            }
            // Queued jobs retain the operation ID and raster: a second click
            // must not silently mint a duplicate while the outbox is pending.
            // The Odoo producer's positive route marker is part of the
            // admission contract. A contradictory "submitted" without it
            // must not discard the exact raster needed for a safe same-id
            // retry after a potentially ambiguous submission.
            const explicitlyUnknownCode = [
                "UNKNOWN_SUBMISSION_OUTCOME", "UNKNOWN_PARTIAL_DELIVERY",
                "AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT",
                "JOB_EXPIRED_DURING_PRINT",
            ].includes(result?.code);
            const status = result?.status === "failed" &&
                (result?.can_retry === false || explicitlyUnknownCode)
                ? "unknown" : result?.status;
            const terminal = result?.gateway_enabled === true &&
                ["submitted", "claimed", "printing", "success", "failed"].includes(status);
            if (terminal) finishPrintOperation(recoveryKey, operationId);
            saleDetailsOps.set(sessionId, {
                id: operationId,
                image: terminal ? undefined : image,
                geometryFingerprint: terminal ? undefined : geometryFingerprint,
                at: Date.now(),
                terminal,
            });
            if (result?.gateway_enabled !== true) {
                throw new Error(_t("Print Gateway returned an invalid Sale Details response."));
            }
            if (!status || ["unknown", "partial"].includes(status)
                || !["queued", "submitted", "claimed", "printing", "success", "failed"].includes(status)) {
                this.env.services.notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true }
                );
            } else if (status === "queued") {
                this.env.services.notification.add(
                    _t("Sales Details queued. Check Print Activity before reprinting."),
                    { type: "warning", sticky: true }
                );
            } else if (["submitted", "claimed", "printing", "success"].includes(status)) {
                this.env.services.notification.add(
                    _t("Sales Details processing; physical paper output is not confirmed."),
                    { type: "info" }
                );
            }
            if (!["queued", "submitted", "claimed", "printing", "success"].includes(status)) {
                if (status === "failed") {
                    this.env.services.notification.add(_t("Sales Details could not be printed."), { type: "danger", sticky: true });
                }
                return false;
            }
            return result;
        } catch (error) {
            const errText = String(error?.data?.message || error?.message || "").toLowerCase();
            const isLicenseOrVerification = (
                errText.includes("license")
                || errText.includes("licence")
                || errText.includes("verification")
                || errText.includes("gateway_billing_limit")
            );
            const preDispatchFailure = !submissionAttempted || isLicenseOrVerification;
            if (activePrintClaim && preDispatchFailure && activePrintClaim.newIntent) {
                finishPrintOperation(activePrintClaim.recoveryKey, activePrintClaim.id);
                const saved = this.pos.gatewaySaleDetailsOperations?.get(sessionId);
                if (saved?.id === activePrintClaim.id) this.pos.gatewaySaleDetailsOperations.delete(sessionId);
            }
            if (preDispatchFailure) {
                console.warn("POS Sale Details direct printing degraded gracefully to native printing:", error);
                return super.onClick();
            }
            if (showGatewayBillingLimitDialog(this.env, error)) {
                return false;
            }
            // Fail-safe parity with the receipt router: notify once and
            // return false instead of re-throwing, so a Gateway failure
            // cannot freeze the Sale Details button with a double dialog.
            if (submissionAttempted) {
                this.env.services.notification.add(
                    _t("Sales Details print outcome is unconfirmed. Check Print Activity and printer before retrying. %s", gatewayServerMessage(error) || ""),
                    { type: "warning", sticky: true }
                );
            } else {
                this.env.services.notification.add(gatewayServerMessage(error) || _t("Sales Details could not be printed."), { type: "danger", sticky: true });
            }
            return false;
        } finally {
            this.pos.gatewaySaleDetailsPending = false;
        }
    },
});
