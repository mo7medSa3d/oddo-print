/** @odoo-module */

export const DEFAULT_RPC_TIMEOUT_MS = 15000;
export const DEFAULT_RENDER_TIMEOUT_MS = 15000;

export class GatewayTimeoutError extends Error {
    constructor(message, { ambiguous = false } = {}) {
        super(message || "Operation timed out");
        this.name = "GatewayTimeoutError";
        this.code = "GATEWAY_TIMEOUT";
        this.gatewayAmbiguous = Boolean(ambiguous);
    }
}

export class GatewayCancelledError extends Error {
    constructor(message = "Operation cancelled") {
        super(message);
        this.name = "GatewayCancelledError";
        this.code = "GATEWAY_CANCELLED";
    }
}

export function isGatewayTimeoutError(error) {
    return error?.code === "GATEWAY_TIMEOUT" || error instanceof GatewayTimeoutError;
}

export function withGatewayDeadline(factory, timeoutMs = DEFAULT_RPC_TIMEOUT_MS, message, options = {}) {
    let timer;
    const operation = Promise.resolve().then(factory);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new GatewayTimeoutError(message, options));
        }, timeoutMs);
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Start an Odoo low-level RPC with a real XMLHttpRequest owned by the caller.
 * Odoo 19 documents settings.xhr specifically for advanced XHR control. This
 * lets field widgets abort stale requests on scope change/unmount and guarantees
 * a finite loading state instead of waiting forever for the browser/network.
 */
export function startRpcWithDeadline(rpcFn, route, params, {
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    silent = false,
    timeoutMessage = "Request timed out",
} = {}) {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let timer;
    let rejectOuter;

    const promise = new Promise((resolve, reject) => {
        rejectOuter = reject;
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                xhr.abort();
            } catch {
                // Abort is best-effort; the timeout result remains authoritative.
            }
            reject(new GatewayTimeoutError(timeoutMessage));
        }, timeoutMs);

        Promise.resolve(rpcFn(route, params, { xhr, silent })).then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });

    return {
        promise,
        cancel() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                xhr.abort();
            } catch {
                // Best-effort cancellation only.
            }
            rejectOuter?.(new GatewayCancelledError());
        },
    };
}
