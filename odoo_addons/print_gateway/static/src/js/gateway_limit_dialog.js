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
        reason: _t("Your organization's Gateway plan has reached its Agent limit."),
    },
    max_printers: {
        title: _t("Printer limit reached"),
        reason: _t("Your organization's Gateway plan has reached its Printer limit."),
    },
    max_jobs_per_minute: {
        title: _t("Print rate limit reached"),
        reason: _t("Your organization's Gateway plan has reached its print throughput limit."),
    },
    max_concurrent_jobs: {
        title: _t("Concurrent print limit reached"),
        reason: _t("Your organization's Gateway plan has reached its active print-job capacity."),
    },
    max_prints_per_period: {
        title: _t("Print allowance reached"),
        reason: _t("Your organization's Gateway plan has used all included print jobs for this billing period."),
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

export function parseGatewayBillingLimit(error) {
    for (const candidate of candidateMessages(error)) {
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
        _t("No new print was sent to the printer."),
        facts.join("  •  "),
        details.entitlement === "max_prints_per_period"
            ? _t("Upgrade the Gateway plan to continue printing before the next billing period.")
            : _t("Upgrade the Gateway plan or wait for capacity to become available."),
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
