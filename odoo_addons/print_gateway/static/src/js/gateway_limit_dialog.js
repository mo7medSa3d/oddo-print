/** @odoo-module **/

import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";

const PREFIX = "GATEWAY_BILLING_LIMIT:";
const ALLOWED_ENTITLEMENTS = new Set([
    "max_agents",
    "max_printers",
    "max_jobs_per_minute",
    "max_concurrent_jobs",
    "max_prints_per_period",
]);

const COPY = {
    max_agents: {
        title: _t("Agent limit reached"),
        reason: _t("You've reached the computer limit on your plan."),
    },
    max_printers: {
        title: _t("Printer limit reached"),
        reason: _t("You've reached the printer limit on your plan."),
    },
    max_jobs_per_minute: {
        title: _t("Print rate limit reached"),
        reason: _t("Too many prints at once. Try again shortly."),
    },
    max_concurrent_jobs: {
        title: _t("Concurrent print limit reached"),
        reason: _t("Too many jobs printing now. Wait a moment."),
    },
    max_prints_per_period: {
        title: _t("Print allowance reached"),
        reason: _t("You've used all prints for this period."),
    },
};

function candidateMessages(error) {
    const candidates = [];
    if (typeof error === "string") {
        candidates.push(error);
    }
    if (error && typeof error === "object") {
        if (typeof error.message === "string") candidates.push(error.message);
        if (typeof error.data?.message === "string") candidates.push(error.data.message);
        if (Array.isArray(error.data?.arguments)) {
            for (const value of error.data.arguments) {
                if (typeof value === "string") candidates.push(value);
            }
        }
        if (Array.isArray(error.data?.args)) {
            for (const value of error.data.args) {
                if (typeof value === "string") candidates.push(value);
            }
        }
    }
    return candidates;
}

const GENERIC_RPC_TITLES = new Set(["Odoo Server Error", "RPC_ERROR", "RPC Error"]);

/**
 * Extract the actionable server-side message from an Odoo RPC rejection.
 *
 * Odoo serializes server exceptions (e.g. ValidationError) into a generic
 * RPCError whose `.message` is the fixed title "Odoo Server Error"; the real
 * message lives in `error.data.message` (and string arguments). Reading only
 * `error.message` therefore renders every deterministic printer failure as a
 * generic server-error alert. Prefer the server message, then string
 * arguments, then the local message unless it is itself the generic title.
 */
export function gatewayServerMessage(error) {
    const fallbacks = [];
    if (error && typeof error === "object") {
        if (typeof error.data?.message === "string" && error.data.message.trim()) {
            return error.data.message;
        }
        for (const key of ["arguments", "args"]) {
            const values = error.data?.[key];
            if (Array.isArray(values)) {
                for (const value of values) {
                    if (typeof value === "string" && value.trim() && !GENERIC_RPC_TITLES.has(value.trim())) {
                        return value;
                    }
                }
            }
        }
        if (typeof error.message === "string" && error.message.trim()) {
            fallbacks.push(error.message);
        }
    } else if (typeof error === "string" && error.trim()) {
        return error;
    }
    for (const candidate of fallbacks) {
        if (!GENERIC_RPC_TITLES.has(candidate.trim())) {
            return candidate;
        }
    }
    return "";
}

export function parseGatewayBillingLimit(error) {    for (const candidate of candidateMessages(error)) {
        const markerIndex = candidate.indexOf(PREFIX);
        if (markerIndex < 0) continue;
        const raw = candidate.slice(markerIndex + PREFIX.length).trim();
        try {
            const details = JSON.parse(raw);
            const entitlement = typeof details?.entitlement === "string" ? details.entitlement : "";
            if (!ALLOWED_ENTITLEMENTS.has(entitlement)) continue;
            return {
                code: typeof details.code === "string" ? details.code : "TENANT_ENTITLEMENT_EXCEEDED",
                entitlement,
                limit: Number.isInteger(details.limit) && details.limit > 0 ? details.limit : null,
                used: Number.isInteger(details.used) && details.used >= 0 ? details.used : null,
                message: typeof details.message === "string" && details.message.trim()
                    ? details.message
                    : COPY[entitlement].reason,
                retryAfterSeconds:
                    Number.isFinite(details.retryAfterSeconds) && details.retryAfterSeconds > 0
                        ? Math.round(details.retryAfterSeconds)
                        : null,
                periodEnd: typeof details.periodEnd === "string" ? details.periodEnd : null,
            };
        } catch {
            // Ignore malformed markers and keep the normal Odoo error path.
        }
    }
    return null;
}

function formatPeriodEnd(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(date);
}

function formatRetryAfter(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const minutes = Math.ceil(seconds / 60);
    return _t("Try again in about %s minute(s).", minutes);
}

export function showGatewayBillingLimitDialog(env, errorOrDetails) {
    const details = errorOrDetails?.entitlement && errorOrDetails?.message
        ? errorOrDetails
        : parseGatewayBillingLimit(errorOrDetails);
    if (!details) return false;

    const copy = COPY[details.entitlement];
    const facts = [];
    if (details.used !== null) {
        facts.push(_t("Used: %s", details.used.toLocaleString()));
    }
    if (details.limit !== null) {
        facts.push(_t("Plan limit: %s", details.limit.toLocaleString()));
    }

    if (details.entitlement === "max_prints_per_period") {
        const periodEnd = formatPeriodEnd(details.periodEnd);
        if (periodEnd) facts.push(_t("Billing period ends: %s", periodEnd));
    }

    const retryText = formatRetryAfter(details.retryAfterSeconds);
    if (retryText) facts.push(retryText);

    const body = [
        details.message || copy.reason,
        _t("Nothing was printed."),
        facts.join("  •  "),
        details.entitlement === "max_prints_per_period"
            ? _t("Upgrade your plan to keep printing.")
            : _t("Upgrade your plan or try again shortly."),
    ].filter(Boolean).join("\n\n");

    env.services.dialog.add(ConfirmationDialog, {
        title: copy.title,
        body,
        confirmLabel: _t("Open Print Activity"),
        cancelLabel: _t("Close"),
        confirm: () => env.services.action.doAction("print_gateway.action_print_gateway_jobs"),
    });
    return true;
}
