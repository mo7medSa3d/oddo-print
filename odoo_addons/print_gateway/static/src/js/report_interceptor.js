/** @odoo-module **/

import { withGatewayDeadline } from "./async_control";
import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";
import { showGatewayBillingLimitDialog, gatewayServerMessage } from "./gateway_limit_dialog";

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

// Do not store cross-user/company state globally by report id alone. The ORM
// service scopes the cache to this web client; the key includes all routing
// context and report arguments. Only uncertain operations remain for 5 minutes.
// Server-side payload fingerprinting is still authoritative: a regenerated PDF
// that differs from an earlier submission is rejected, never silently reprinted.
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

    let operations, operationKey, operation;
    let ownsOperation = false;
    try {
        const request = {
            report_name: action.report_name,
            report_id: action.id,
            res_ids: resIds,
            context: action.context || {},
            data: action.data ?? null,
        };
        operationKey = JSON.stringify(request);
        operations = reportOperations.get(orm);
        if (!operations) {
            operations = new Map();
            reportOperations.set(orm, operations);
        }
        const now = Date.now();
        for (const [key, value] of operations) {
            if (!value.pending && now - value.at >= 5 * 60 * 1000) operations.delete(key);
        }
        operation = operations.get(operationKey);
        if (operation?.pending) return true;
        if (!operation) {
            operation = {
                at: now,
                request: { ...JSON.parse(operationKey), operation_id: reportOperationUuid() },
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
                _t("We couldn't complete this print request. Native PDF download cancelled. Check Print Activity for details."),
                { type: "danger", sticky: true, buttons: [openJobsButton(env)] }
            );
            return true;
        }

        if (!res.has_binding) operations.delete(operationKey);
        if (res.status === "failed") operations.delete(operationKey);
        if (res.has_binding && (res.billing_limit || res.success === false || !res.dispatched)) {
            if (res.billing_limit && showGatewayBillingLimitDialog(env, res.billing_limit)) {
                return true;
            }
            // Sticky: a failed interception must stay visible — unlike the
            // transient success toast, a failure needs an explicit dismiss
            // so the operator never misses that no paper came out.
            notification.add(
                res.error || _t("Gateway print failed for bound printer. Native download cancelled."),
                { type: "danger", sticky: true, buttons: [openJobsButton(env)] }
            );
            return true; // FAIL-CLOSED: Bound printer failed, do not bypass to browser PDF
        }

        if (res && (res.dispatched || res.success)) {
            // The interceptor must never greenlight an UNKNOWN outcome: the
            // dispatch call succeeded but the physical result is ambiguous.
            // Both toasts link to Print Jobs so the interception never
            // leaves the user without a next step.
            const openJobs = openJobsButton(env);
            if (res.status === "failed") {
                notification.add(
                    res.error || _t("Gateway print failed for bound printer. Native download cancelled."),
                    { type: "danger", sticky: true, buttons: [openJobs] }
                );
            } else if (["queued", "submitted", "claimed", "printing", "success"].includes(res.status)) {
                operations.delete(operationKey);
                notification.add(
                    res.message || _t("Document sent to %s. Check Print Activity for the final status.", res.printer_name || _t("Printer")),
                    { type: "success", buttons: [openJobs] }
                );
            } else {
                // Missing/unrecognized states are not evidence of acceptance.
                notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true, buttons: [openJobs] }
                );
            }
            return true; // Cancel default browser PDF dialog
        }
    } catch (err) {
        if (showGatewayBillingLimitDialog(env, err)) {
            return true;
        }
        // Same persistence rule as a failed dispatch: an RPC-level error
        // must stay visible until dismissed, with the Jobs list one click
        // away for verification.
        notification.add(
            _t("Printing service error: %s", gatewayServerMessage(err) || _t("We couldn't complete this print request. Native PDF download cancelled. Check Print Activity for details.")),
            { type: "danger", sticky: true, buttons: [openJobsButton(env)] }
        );
        return true; // FAIL-CLOSED: Dispatch call failed, cancel native PDF dialog
    } finally {
        if (ownsOperation) operation.pending = false;
    }

    return false; // Fallback to standard Odoo report action only when no binding exists
}

registry.category("ir.actions.report handlers").add("silent_gateway_handler", silentPrintReportHandler, { sequence: 5 });
