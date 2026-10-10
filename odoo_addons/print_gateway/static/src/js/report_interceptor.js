/** @odoo-module **/

import { withGatewayDeadline } from "./async_control";
import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";
import { showGatewayBillingLimitDialog, gatewayServerMessage } from "./gateway_limit_dialog";
import { printRecoveryKey, claimPrintOperation, finishPrintOperation } from "./operation_recovery";

/**
 * OWL 3 silent report interceptor.
 * Catches ir.actions.report execution in the web client and silently dispatches
 * through the Print Gateway if a binding exists for the current branch/company context.
 *
 * Strict Fail-Closed Policy:
 * - If NO binding exists: returns false to allow standard Odoo report download.
 * - If a binding DOES exist and dispatch fails: displays an error notification and
 *   returns true to cancel native browser PDF download, preventing hardware bypass.
 */
/**
 * Persistent next step for every interception outcome: opens the Print Jobs
 * list so the operator can verify the real job state instead of relying on
 * a transient toast.
 */
function openJobsButton(env) {
    return {
        name: _t("Open Print Activity"),
        primary: true,
        onClick: () => env.services.action.doAction("print_gateway.action_print_gateway_jobs"),
    };
}

function normalizeIds(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
        .filter((id) =>
            (typeof id === "number" && Number.isInteger(id) && id > 0) ||
            (typeof id === "string" && /^\d+$/.test(id) && Number(id) > 0)
        )
        .map(Number);
}

function firstNonEmptyIds(...sources) {
    for (const source of sources) {
        const ids = normalizeIds(source);
        if (ids.length) {
            return ids;
        }
    }
    return [];
}

// One operation identity per click: uncertain retries retain it in the
// ORM-scoped cache below; a confirmed outcome ends the reuse window. Fail
// closed without a secure RNG so distinct operations never collapse to one key.
function reportOperationUuid() {
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

// The ORM-WeakMap owns live exact-report requests; only opaque unresolved
// identities persist in browser storage. After reload do not rerender/replay a
// potentially different PDF with a new key: direct operator to Print Activity.
const reportOperations = new WeakMap();

async function silentPrintReportHandler(action, options, env) {
    if (action.type !== "ir.actions.report" || action.report_type !== "qweb-pdf") {
        return false;
    }

    const orm = env.services.orm;
    const notification = env.services.notification;
    const resIds = firstNonEmptyIds(
        options?.active_ids,
        options?.res_ids,
        action.context?.active_ids,
        action.context?.active_id,
        action.res_ids,
        action.docids,
        action.data?.res_ids,
        action.data?.docids
    );

    let operations, operationKey, operation, recoveryKey, claim;
    let ownsOperation = false;
    try {
        const request = {
            report_name: action.report_name,
            report_id: action.id,
            res_ids: resIds,
            context: action.context || {},
            data: action.data ?? null,
        };
        // One ORM service can outlive an active-company/user switch. Report
        // names and record ids alone do not identify the same physical print:
        // a company change can select a different binding and printer.
        // Snapshot the dispatched request so same-scope uncertain retries
        // always replay the original parameters and operation id.
        const requestSnapshot = JSON.parse(JSON.stringify(request));
        operationKey = JSON.stringify([
            env.services.user?.userId || 0,
            env.services.company?.currentCompany?.id || 0,
            requestSnapshot,
        ]);
        operations = reportOperations.get(orm);
        if (!operations) {
            operations = new Map();
            reportOperations.set(orm, operations);
        }
        operation = operations.get(operationKey);
        if (operation?.pending) return true;
        recoveryKey = printRecoveryKey("report", [
            env.services.user?.userId || 0,
            env.services.company?.currentCompany?.id || 0,
            operationKey,
        ]);
        claim = claimPrintOperation(recoveryKey,
            operation?.request?.operation_id || null, Boolean(operation?.request), reportOperationUuid);
        if (claim.blocked) {
            notification.add(
                _t("A previous report print is unresolved after this page changed. Check Print Activity and the printer. Use an explicit reprint from Print Activity instead of creating a new job."),
                { type: "warning", sticky: true, buttons: [openJobsButton(env)] }
            );
            return true;
        }
        if (!operation) {
            operation = {
                at: Date.now(),
                request: { ...requestSnapshot, operation_id: claim.id },
            };
            operations.set(operationKey, operation);
        }
        // Acquire before the first await, including report rendering on the
        // server. A second click must not allocate a second operation identity.
        operation.pending = true;
        ownsOperation = true;
        const res = await withGatewayDeadline(
            () => orm.call("print_gateway.binding", "dispatch_report_action", [], operation.request),
            20000,
            _t("Printing service request timed out."),
            { ambiguous: true },
        );

        // The controller contract always returns an explicit boolean
        // has_binding. A malformed response is a dispatch failure and must
        // remain fail-closed; it must never silently reopen native PDF printing.
        if (!res || typeof res !== "object" || typeof res.has_binding !== "boolean") {
            notification.add(
                _t("Print request returned no reliable status. Native PDF download cancelled. Check Print Activity and the printer before retrying."),
                { type: "warning", sticky: true, buttons: [openJobsButton(env)] }
            );
            return true;
        }

        if (!res.has_binding || (res.status === "failed" && res.dispatched === false)) {
            finishPrintOperation(recoveryKey, operation.request.operation_id);
            operations.delete(operationKey);
        }
        if (res.has_binding) {
            if (res.billing_limit && showGatewayBillingLimitDialog(env, res.billing_limit)) {
                return true;
            }
            const openJobs = openJobsButton(env);
            const admitted = ["submitted", "claimed", "printing", "success"].includes(res.status);
            if (res.status === "failed") {
                notification.add(
                    res.error || res.message || _t("Gateway print failed for bound printer. Native download cancelled."),
                    { type: "danger", sticky: true, buttons: [openJobs] }
                );
            } else if (res.status === "queued" && res.dispatched) {
                // Keep the same operation ID: another click is a retry of
                // the durable outbox entry, not permission to print twice.
                notification.add(
                    res.message || _t("Print job queued in Odoo. Check Print Activity before reprinting."),
                    { type: "warning", sticky: true, buttons: [openJobs] }
                );
            } else if (admitted && res.dispatched && res.success !== false) {
                finishPrintOperation(recoveryKey, operation.request.operation_id);
                operations.delete(operationKey);
                notification.add(
                    res.message || _t("Printing service is processing this job; paper output is not yet confirmed."),
                    { type: "info", buttons: [openJobs] }
                );
            } else if (["unknown", "partial"].includes(res.status) || res.dispatched) {
                // A missing or contradictory outcome is not a definitive
                // failure; do not reset the operation key and risk a duplicate.
                notification.add(
                    _t("Print status is unknown. Check the printer and Print Activity before trying again."),
                    { type: "warning", sticky: true, buttons: [openJobs] }
                );
            } else {
                notification.add(
                    res.error || _t("Gateway print failed for bound printer. Native download cancelled."),
                    { type: "danger", sticky: true, buttons: [openJobs] }
                );
            }
            return true; // Bound printer always fails closed to native PDF
        }
    } catch (err) {
        if (showGatewayBillingLimitDialog(env, err)) {
            return true;
        }
        // An RPC exception/timeout does NOT prove the Gateway never received
        // the job. Do not suggest a fresh operation ID or automatic reprint.
        notification.add(
            _t("Print outcome unconfirmed (%s). Native PDF download cancelled. Check Print Activity and printer before retrying.", gatewayServerMessage(err) || _t("Printing service response unavailable")),
            { type: "warning", sticky: true, buttons: [openJobsButton(env)] }
        );
        return true; // FAIL-CLOSED: Dispatch call failed, cancel native PDF dialog
    } finally {
        if (ownsOperation) operation.pending = false;
    }

    return false; // Fallback to standard Odoo report action only when no binding exists
}

registry.category("ir.actions.report handlers").add("silent_gateway_handler", silentPrintReportHandler, { sequence: 5 });
