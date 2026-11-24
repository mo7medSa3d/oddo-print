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

// Resolve on each use: a module-import-time _t cache keeps the previous locale.
function billingCopy() { return {
    max_agents: {
        title: _t("Computer safety limit reached"),
        reason: _t("Contact your administrator to review the platform's technical capacity."),
    },
    max_printers: {
        title: _t("Printer safety limit reached"),
        reason: _t("Contact your administrator to review the platform's technical capacity."),
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
        reason: _t("You have used the current monthly print allowance."),
    },
}; }

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
export function gatewayDiagnosticMessage(error) {
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

/**
 * A stable, machine-readable Gateway refusal outweighs incidental words in
 * an RPC traceback. An unrelated UNKNOWN_ diagnostic must not turn a definite
 * quota rejection into a possibly-printed result, nor the reverse.
 */
function gatewayMachineCode(error) {
    if (!error || typeof error !== "object") return "";
    const values = [error.data?.code, error.code];
    return values.find((value) => typeof value === "string" && /^(?:PRINT_QUOTA_EXCEEDED|MAX_PRINTS_PER_PERIOD|TENANT_ENTITLEMENT_EXCEEDED|TENANT_SUBSCRIPTION_REQUIRED|TENANT_ENTITLEMENT_UNAVAILABLE|TENANT_SUSPENDED|TENANT_DELETED|PRINTER_OFFLINE|PRINTER_UNAVAILABLE|PRINTER_NOT_FOUND|PRINTER_NOT_SHARED|AGENT_OFFLINE|DEVICE_NOT_APPROVED|UNKNOWN_SUBMISSION_OUTCOME|UNKNOWN_PARTIAL_DELIVERY|AGENT_EXECUTION_TIMEOUT|AGENT_RESTART_DURING_PRINT|JOB_EXPIRED_DURING_PRINT)$/.test(value)) || "";
}

/** Customer boundary: remote/native exceptions are evidence, never UI copy. */
export function gatewayServerMessage(error) {
    const raw = gatewayDiagnosticMessage(error);
    const stableCode = gatewayMachineCode(error);
    if (!raw && !stableCode) return "";
    const code = stableCode || raw.slice(0, 4096).toUpperCase();
    if (/UNKNOWN_|UNCERTAIN|PARTIAL_DELIVERY|AMBIGUOUS/.test(code)) {
        return _t("The print result needs review. Check the printer before starting another print to avoid duplicate output.");
    }
    if (/PRINT_QUOTA_EXCEEDED|MAX_PRINTS_PER_PERIOD/.test(code)) {
        return _t("You have used the monthly allowance. Wait for the next UTC reset or contact the workspace owner.");
    }
    if (/TENANT_ENTITLEMENT_EXCEEDED/.test(code)) {
        const requested = error && typeof error === "object"
            ? (error.data?.entitlement ?? error.entitlement)
            : null;
        // A throughput or concurrency safeguard is not an exhausted
        // commercial monthly allowance. Only known entitlement keys may
        // select a remedy, never a free-text backend message.
        return ALLOWED_ENTITLEMENTS.has(requested)
            ? billingCopy()[requested].reason
            : _t("Contact your administrator to review the platform's technical capacity.");
    }
    if (/SUBSCRIPTION|TENANT_ENTITLEMENT_UNAVAILABLE|TENANT_SUSPENDED|TENANT_DELETED/.test(code)) {
        return _t("Printing is not active for this workspace. Ask the workspace owner to review its subscription in Yaseir.");
    }
    if (/PRINTER_OFFLINE|PRINTER_UNAVAILABLE|AGENT_OFFLINE|PRINTER_NOT_FOUND|PRINTER_NOT_SHARED/.test(code)) {
        return _t("The selected printer is unavailable. Check its computer, power and connection before trying again.");
    }
    if (/VERIFICATION|UNVERIFIED|DEVICE_NOT_APPROVED/.test(code)) {
        return _t("Verify this printer in the Windows printing app before selecting it in Odoo.");
    }
    if (/GATEWAY_INSTALLATION_|API_KEY|CREDENTIAL|UNAUTHORIZED/.test(code)) {
        return _t("The Odoo connection needs attention. Ask your administrator to review Connect Odoo and its connection key.");
    }
    if (/NO_BINDING|NO PRINT RULE|NOT ASSIGNED|BINDING_NOT_FOUND/.test(code)) {
        return _t("Choose a verified printer for this document and company in the printer settings.");
    }
    return _t("This printing action could not be completed. Check the connection and Print Activity before retrying. Contact your administrator if the problem continues.");
}

/**
 * ValidationError/RPCError envelopes can append a traceback after the JSON
 * billing marker. Extract exactly the balanced JSON object without accepting
 * a second marker, leaking the traceback, or treating braces inside strings
 * as object boundaries. Bound parsing so untrusted errors cannot grow work.
 */
function billingMarkerJson(candidate, markerIndex) {
    const payload = candidate.slice(markerIndex + PREFIX.length, markerIndex + PREFIX.length + 8192);
    const leading = payload.match(/^\s*/)[0].length;
    if (payload[leading] !== "{") return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = leading; i < payload.length; i += 1) {
        const ch = payload[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') quoted = false;
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === "{") {
            depth += 1;
        } else if (ch === "}") {
            depth -= 1;
            if (depth === 0) return payload.slice(leading, i + 1);
        }
    }
    return null;
}

/** A limit dialog asserts definite pre-admission refusal. Never infer that
 * from an unrelated UNKNOWN outcome marker or an arbitrary billing-shaped RPC
 * payload; legacy markers without a code keep their historical interpretation. */
function validBillingLimitEvidence(details) {
    if (!details || typeof details !== "object" || !ALLOWED_ENTITLEMENTS.has(details.entitlement)) return false;
    if (details.code === undefined) return true;
    if (details.code === "PRINT_QUOTA_EXCEEDED" || details.code === "MAX_PRINTS_PER_PERIOD") {
        return details.entitlement === "max_prints_per_period";
    }
    return details.code === "TENANT_ENTITLEMENT_EXCEEDED";
}

export function parseGatewayBillingLimit(error) {
    const stableCode = gatewayMachineCode(error);
    if (stableCode && !["PRINT_QUOTA_EXCEEDED", "MAX_PRINTS_PER_PERIOD", "TENANT_ENTITLEMENT_EXCEEDED"].includes(stableCode)) {
        // A definite non-limit code, especially UNKNOWN_SUBMISSION_OUTCOME,
        // overrides a billing-shaped string found in an old RPC traceback.
        return null;
    }
    for (const candidate of candidateMessages(error)) {
        const markerIndex = candidate.indexOf(PREFIX);
        if (markerIndex < 0) continue;
        const raw = billingMarkerJson(candidate, markerIndex);
        if (!raw) continue;
        try {
            const details = JSON.parse(raw);
            const entitlement = typeof details?.entitlement === "string" ? details.entitlement : "";
            if (!validBillingLimitEvidence(details)) continue;
            if (stableCode && details.code && stableCode !== details.code) continue;
            return {
                code: typeof details.code === "string" ? details.code : "TENANT_ENTITLEMENT_EXCEEDED",
                entitlement,
                limit: Number.isInteger(details.limit) && details.limit > 0 ? details.limit : null,
                used: Number.isInteger(details.used) && details.used >= 0 ? details.used : null,
                message: billingCopy()[entitlement].reason,
                retryAfterSeconds:
                    Number.isFinite(details.retryAfterSeconds) && details.retryAfterSeconds > 0
                        ? Math.round(details.retryAfterSeconds)
                        : null,
                periodEnd: typeof details.periodEnd === "string" ? details.periodEnd : null,
                manualReprintRequired: details.manualReprintRequired === true,
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
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
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
    // Direct RPC detail objects bypass parseGatewayBillingLimit. Keep the
    // same allowlist and numeric validation on this second entry point:
    // malformed backend metadata must not crash or mislabel the print dialog.
    if (!validBillingLimitEvidence(details)) return false;

    const copy = billingCopy()[details.entitlement];
    if (!copy) return false;
    const facts = [];
    if (typeof details.used === "number" && Number.isSafeInteger(details.used) && details.used >= 0) {
        facts.push(_t("Used: %s", details.used.toLocaleString()));
    }
    if (typeof details.limit === "number" && Number.isSafeInteger(details.limit) && details.limit > 0) {
        facts.push(_t("Allowance: %s", details.limit.toLocaleString()));
    }

    if (details.entitlement === "max_prints_per_period") {
        const periodEnd = formatPeriodEnd(details.periodEnd);
        if (periodEnd) facts.push(_t("Monthly allowance resets (UTC): %s", periodEnd));
    }

    const retryText = formatRetryAfter(details.retryAfterSeconds);
    if (retryText) facts.push(retryText);

    const body = [
        copy.reason,
        _t("This request was not accepted for printing. Check Print Activity for any earlier attempts."),
        facts.join("  •  "),
        details.entitlement === "max_prints_per_period"
            ? details.manualReprintRequired
                ? _t("This receipt was not printed. After renewal, reprint it explicitly only if still needed.")
                : _t("Wait for the next UTC monthly reset or contact the workspace owner to increase the allowance.")
            : _t("Wait for current work to finish. Contact your administrator if the limit continues."),
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
