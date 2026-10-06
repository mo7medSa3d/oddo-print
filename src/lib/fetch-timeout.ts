/** Bounded fetch for browser request flows: every request carries a total
 * deadline so a stalled connection surfaces as a retryable error instead of
 * hanging the screen forever (C063). An caller-supplied AbortSignal still
 * wins (it aborts first); otherwise the timeout fires. */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onCallerAbort);
  }
}
