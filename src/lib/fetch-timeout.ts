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
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  // AbortSignal.timeout() owns its lifecycle; do not clear it at response
  // headers. AbortSignal.any() preserves caller cancellation *after* headers
  // and keeps the original response status, URL, streaming and clone contract.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (deadline.aborted && !init.signal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}
