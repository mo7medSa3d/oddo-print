import type { IncomingMessage, ServerResponse } from "http";

/**
 * Response-policy defaults for the custom server boundary.
 *
 * lib/cache.ts documents the caching contract: only routes that explicitly
 * attach PUBLIC_VARY_CACHE_CONTROL (or an explicit no-store) opt into a
 * cache policy — "every other data route stays `no-store`". Next.js App
 * Router does not stamp Cache-Control on dynamic route handlers by default,
 * so without this boundary authenticated /api/* responses leave the process
 * with no Cache-Control at all and become eligible for heuristic/shared
 * caching by intermediaries.
 *
 * The default is stamped lazily, when the response head is written: any
 * Cache-Control the route itself produced is already on the ServerResponse
 * at that point and wins. Pre-setting the header at request time instead
 * would shadow route-provided policies (Next's Node adapter does not
 * reliably overwrite an existing Cache-Control), which would silently turn
 * the public, CDN-cacheable /api/billing/plans response private.
 */
export function applyApiCacheControlDefault(req: IncomingMessage, res: ServerResponse): void {
  if (!req.url?.startsWith("/api/")) return;
  if (res.headersSent) return;
  const state = res as ServerResponse & { __apiCacheDefaultInstalled?: boolean };
  if (state.__apiCacheDefaultInstalled) return;
  state.__apiCacheDefaultInstalled = true;

  const stampDefault = () => {
    if (res.headersSent || res.writableEnded) return;
    if (res.getHeader("cache-control") !== undefined) return;
    res.setHeader("Cache-Control", "no-store");
  };
  // Wrap write-head/end so the default is stamped at the latest possible
  // moment that is still before the response head is serialized. The casts
  // preserve Node's overloaded signatures (spread parameters only capture
  // the last overload).
  const originalWriteHead = res.writeHead.bind(res);
  const originalEnd = res.end.bind(res);
  res.writeHead = ((...args: Parameters<typeof originalWriteHead>) => {
    stampDefault();
    return originalWriteHead(...args);
  }) as typeof res.writeHead;
  res.end = ((...args: Parameters<typeof originalEnd>) => {
    stampDefault();
    return originalEnd(...args);
  }) as typeof res.end;
}
