/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { gatewayServerMessage, showGatewayBillingLimitDialog } from "./gateway_limit_dialog";
import { withGatewayDeadline } from "./async_control";
import { PosTicketPrinterPlugin } from "@point_of_sale/app/plugins/pos_ticket_printer_plugin";
import { renderGatewayReceiptJpeg } from "./receipt_raster";
import { printRecoveryKey, claimPrintOperation, finishPrintOperation, gatewayOperationUuid, pollQueuedPrintJob } from "./operation_recovery";

const nextOperationId = () => gatewayOperationUuid(_t("Secure random number generator is unavailable; cannot generate print operation idempotency key"));

function gatewayDataCall(plugin, model, method, args, kwargs = {}, { ambiguous = false } = {}) {
    return withGatewayDeadline(
        () => plugin.data.call(model, method, args, kwargs, false),
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

patch(PosTicketPrinterPlugin.prototype, {
    async printSaleDetailsReceipt({ webFallback = true, download = false } = {}) {
        const sessionId = this.session?.id;
        if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
            this.notification.add(_t("Open a POS session before printing."), { type: "danger", sticky: true });
            return false;
        }

        if (this.gatewaySaleDetailsPending) {
            return false;
        }
        this.gatewaySaleDetailsPending = true;
        let submissionAttempted = false;
        let activePrintClaim = null;
        let iframe = null;
        try {
            let enabled = false;
            try {
                enabled = await gatewayDataCall(
                    this, "pos.session", "is_gateway_printing_enabled", [[sessionId]],
                );
            } catch (probeError) {
                console.warn("POS Sale Details service check failed; falling back to native printing:", probeError);
                return super.printSaleDetailsReceipt({ webFallback, download });
            }
            if (enabled !== true) {
                return super.printSaleDetailsReceipt({ webFallback, download });
            }

            const saleDetailsOps = (this.gatewaySaleDetailsOperations ||= new Map());
            const lastOp = saleDetailsOps.get(sessionId);
            const memoryRetry = Boolean(lastOp?.terminal === false && lastOp?.image);
            const companyId = this.config?.company_id?.id || this._gatewayPosStore?.company?.id || 0;
            const recoveryKey = printRecoveryKey("sale-details", [
                companyId, sessionId, this.config?.id || 0,
            ]);
            const claim = await claimPrintOperation(
                recoveryKey, memoryRetry ? lastOp.id : null, memoryRetry, nextOperationId,
            );
            if (claim.blocked) {
                this.notification.add(
                    _t("An earlier Sales Details print is unresolved after this page changed. Check Print Activity and the printer. Use the explicit reprint action in Print Activity if another paper copy is needed."),
                    { type: "warning", sticky: true },
                );
                return false;
            }
            activePrintClaim = { recoveryKey, id: claim.id, newIntent: claim.newIntent };
            const operationId = claim.id;
            let image = memoryRetry ? lastOp.image : undefined;
            let geometryFingerprint = memoryRetry ? lastOp.geometryFingerprint : undefined;
            if (!memoryRetry) {
                const saleDetails = await gatewayDataCall(
                    this, "report.point_of_sale.report_saledetails",
                    "get_sale_details", [false, false, false, [sessionId]],
                );
                const generator = this.getGenerator({ models: this.data.models });
                const data = generator.generateSaleDetailsData(saleDetails);
                iframe = await this.generateIframe("point_of_sale.pos_sale_details_receipt", data);
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                const iframeEl = doc?.getElementById("pos-receipt");
                if (!iframeEl) {
                    throw new Error(_t("Unable to locate the rendered POS Sales Details receipt."));
                }
                const geometry = await gatewayDataCall(
                    this, "pos.session", "get_gateway_sale_details_geometry", [[sessionId]],
                );
                image = await withGatewayDeadline(
                    () => renderGatewayReceiptJpeg(iframeEl, { geometry }),
                    15000,
                    _t("Receipt rendering timed out."),
                );
                geometryFingerprint = geometry.config_fingerprint;
            }
            saleDetailsOps.set(sessionId, { id: operationId, image, geometryFingerprint, terminal: false, at: Date.now() });
            submissionAttempted = true;
            const result = await gatewayDataCall(
                this,
                "pos.session",
                "action_print_gateway_sale_details",
                [[sessionId]],
                { image, operation_id: operationId, geometry_fingerprint: geometryFingerprint },
                { ambiguous: true },
            );

            const explicitlyUnknownCode = [
                "UNKNOWN_SUBMISSION_OUTCOME", "UNKNOWN_PARTIAL_DELIVERY",
                "AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT",
                "JOB_EXPIRED_DURING_PRINT",
            ].includes(result?.code);
            let status = result?.status === "failed" &&
                (result?.can_retry === false || explicitlyUnknownCode)
                ? "unknown" : result?.status;
            if (result?.gateway_enabled === true && status === "queued") {
                const live = await pollQueuedPrintJob(this.env?.services?.orm, result?.job_id);
                if (live) {
                    status = live.status === "failed" &&
                        (result?.can_retry === false || explicitlyUnknownCode)
                        ? "unknown" : live.status;
                }
            }
            const terminal = result?.gateway_enabled === true &&
                (["submitted", "claimed", "printing", "success"].includes(status) ||
                    (status === "failed" && result?.can_retry === true));
            if (terminal) {
                finishPrintOperation(recoveryKey, operationId);
            }
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
                this.notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true }
                );
            } else if (status === "queued") {
                this.notification.add(
                    _t("Sales Details queued. Check Print Activity before reprinting."),
                    { type: "warning", sticky: true }
                );
            } else if (["submitted", "claimed", "printing", "success"].includes(status)) {
                this.notification.add(
                    _t("Sales Details processing; physical paper output is not confirmed."),
                    { type: "info" }
                );
            }
            if (!["queued", "submitted", "claimed", "printing", "success"].includes(status)) {
                if (status === "failed") {
                    this.notification.add(_t("Sales Details could not be printed."), { type: "danger", sticky: true });
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
                const saved = this.gatewaySaleDetailsOperations?.get(sessionId);
                if (saved?.id === activePrintClaim.id) {
                    this.gatewaySaleDetailsOperations.delete(sessionId);
                }
            }
            if (preDispatchFailure) {
                console.warn("POS Sale Details direct printing degraded gracefully to native printing:", error);
                return super.printSaleDetailsReceipt({ webFallback, download });
            }
            const env = this.env || this._gatewayPosStore?.env || {
                services: { notification: this.notification, dialog: this.dialog },
            };
            if (showGatewayBillingLimitDialog(env, error)) {
                return false;
            }
            this.notification.add(
                _t("Sales Details print outcome is unconfirmed. Check Print Activity and printer before retrying. %s", gatewayServerMessage(error) || ""),
                { type: "warning", sticky: true }
            );
            return false;
        } finally {
            try {
                iframe?.remove();
            } catch {
                // Ignore frame cleanup failures.
            }
            this.gatewaySaleDetailsPending = false;
        }
    },
});
