/** Bounded browser fetch across headers AND streaming response consumption.
 *
 * The fetch() promise resolves once response HEADERS arrive. Cleaning up a
 * setTimeout() in its finally block therefore silently cancels the deadline
 * before response.json()/text()/blob() have read the body. Native AbortSignal
 * composition remains active for the complete response stream, including
 * cloned responses, without wrapping or buffering any Response body.
 *
 * Note: after headers, the browser may surface AbortError rather than our
 * pre-header timeout message. The body is still aborted and is NOT safe to
 * treat as an unsubmitted mutation or immediately retry a print operation.
 */
import { ensureCustomerSession } from "./session-config";

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  // AbortSignal.timeout() owns its lifecycle; do not clear it at response
  // headers. AbortSignal.any() preserves caller cancellation *after* headers
  // and keeps the original response status, URL, streaming and clone contract.
  // fetch(Request, init) inherits the Request's signal unless init explicitly
  // supplies one (including null). Replacing it with only a deadline silently
  // sends an already-cancelled mutation and loses navigation cancellation.
  const callerSignal = init.signal === undefined && typeof Request !== "undefined" && input instanceof Request
    ? input.signal
    : init.signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  try {
    const response = await fetch(input, { ...init, signal });
    return response;
  } catch (error) {
    if (deadline.aborted && !callerSignal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Retry-once-after-refresh wrapper for workspace fetches. `fetchWithTimeout`
 * above is deliberately unchanged: existing callers keep its exact behaviour.
 *
 * Rules (session policy is NOT changed by this wrapper):
 * - Only a 401 triggers recovery. 403 (including CSRF/origin),
 *   subscription/authorization errors, 5xx, and network failures are never
 *   treated as refreshable and are returned untouched.
 * - On a refreshable 401, `ensureCustomerSession()` runs exactly once
 *   (single-flight via its own in-memory flight + Web Locks — never
 *   reimplemented here). If it reports authenticated:false, or if it
 *   throws (network/5xx), the ORIGINAL 401 response is returned: no
 *   second refresh, no retry loop, and no navigation decision here —
 *   callers own redirects.
 * - `autoRetry: true` (default): the SAME request is replayed exactly once
 *   with the same input/init, so an Idempotency-Key header or an identical
 *   payload is reused verbatim. Callers must only use this for reads or
 *   for mutations that are idempotent by design (see each call site).
 * - `autoRetry: false`: the request is NOT resent. Instead a synthetic
 *   401 response marked with `SESSION_RENEWED_NOT_RESENT_HEADER` is
 *   returned. Callers check `isSessionRenewedNotResent()` FIRST and show
 *   a "session renewed — please retry" notice without a login redirect
 *   and without clearing form state; the user resubmits explicitly.
 * - This wrapper never redirects, never touches cookies or browser
 *   storage: a silent refresh only renews the access token, it does not
 *   extend idle time.
 */
const SESSION_RENEWED_NOT_RESENT_HEADER = "X-Yaseir-Session-Renewed";
const SESSION_RENEWED_NOT_RESENT_CODE = "SESSION_RENEWED_NOT_RESENT";

export function isSessionRenewedNotResent(response: Response): boolean {
  try {
    return response.headers.get(SESSION_RENEWED_NOT_RESENT_HEADER) === "1";
  } catch {
    return false;
  }
}

type SessionRetryOptions = {
  /** Override the per-attempt timeout (default: the 15 s of fetchWithTimeout). */
  timeoutMs?: number;
  /**
   * True (default): replay the request once after a successful refresh.
   * False: refresh only, then return the synthetic renewed-not-resent
   * response instead of resending. Use false for mutations that are NOT
   * idempotent by design and carry no reusable idempotency key.
   */
  autoRetry?: boolean;
};

function sessionRenewedNotResentResponse(): Response {
  return new Response(JSON.stringify({ ok: false, code: SESSION_RENEWED_NOT_RESENT_CODE }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      [SESSION_RENEWED_NOT_RESENT_HEADER]: "1",
    },
  });
}

export async function fetchWithSessionRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: SessionRetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const autoRetry = options.autoRetry !== false;
  const response = await fetchWithTimeout(input, init, timeoutMs);
  if (response.status !== 401) return response;
  let session: { authenticated: boolean; expiresAt: number };
  try {
    session = await ensureCustomerSession();
  } catch {
    // Refresh transport failure: hand the caller its original 401, do not loop.
    return response;
  }
  if (!session.authenticated) return response;
  void response.body?.cancel().catch(() => {});
  if (!autoRetry) return sessionRenewedNotResentResponse();
  return fetchWithTimeout(input, init, timeoutMs);
}
