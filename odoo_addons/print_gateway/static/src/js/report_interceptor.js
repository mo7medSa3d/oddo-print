/** @odoo-module **/

import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";

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

    try {
        const res = await orm.call(
            "print_gateway.binding",
            "dispatch_report_action",
            [],
            {
                report_name: action.report_name,
                report_id: action.id,
                res_ids: resIds,
                context: action.context || {},
                data: action.data ?? null,
            }
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

        if (res.has_binding && (res.success === false || !res.dispatched)) {
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
            if (["unknown", "partial"].includes(res.status)) {
                notification.add(
                    _t("Print status is unknown. Check the printer before trying again."),
                    { type: "warning", sticky: true, buttons: [openJobs] }
                );
            } else {
                notification.add(
                    res.message || _t("Document sent to %s. Check Print Activity for the final status.", res.printer_name || "Printer"),
                    { type: "success", buttons: [openJobs] }
                );
            }
            return true; // Cancel default browser PDF dialog
        }
    } catch (err) {
        // Same persistence rule as a failed dispatch: an RPC-level error
        // must stay visible until dismissed, with the Jobs list one click
        // away for verification.
        notification.add(
            _t("Printing service error: %s", err?.message || err),
            { type: "danger", sticky: true, buttons: [openJobsButton(env)] }
        );
        return true; // FAIL-CLOSED: Dispatch call failed, cancel native PDF dialog
    }

    return false; // Fallback to standard Odoo report action only when no binding exists
}

registry.category("ir.actions.report handlers").add("silent_gateway_handler", silentPrintReportHandler, { sequence: 5 });
