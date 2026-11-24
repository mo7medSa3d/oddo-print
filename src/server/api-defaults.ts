import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "node:stream";
import { requestPath } from "./request-path";

export function securityHeaders(): Record<string, string> {
  // Match next.config.ts, including redirects and rejections that never reach
  // Next's configured headers. HSTS remains production-only for local HTTP.
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-DNS-Prefetch-Control": "off",
    ...(process.env.NODE_ENV === "production"
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
}

export function applyHttpSecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (res.getHeader(name) === undefined) res.setHeader(name, value);
  }
}

/** Parser failures occur before a request/response pair reaches the handler. */
export function handleHttpClientError(error: NodeJS.ErrnoException, socket: Duplex): void {
  // Match Node's in-flight-response protection: never append a second HTTP
  // response after a partial application response has already been written.
  const active = (socket as Duplex & { _httpMessage?: ServerResponse })._httpMessage;
  if (!socket.writable || socket.writableEnded || socket.destroyed || active?.headersSent || error.code === "ECONNRESET") {
    socket.destroy();
    return;
  }
  const [status, reason] = error.code === "HPE_HEADER_OVERFLOW" ? [431, "Request Header Fields Too Large"]
    : error.code === "HPE_CHUNK_EXTENSIONS_OVERFLOW" ? [413, "Payload Too Large"]
      : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? [408, "Request Timeout"]
        : [400, "Bad Request"];
  const body = JSON.stringify({ error: "INVALID_HTTP_REQUEST" });
  const headers = {
    ...securityHeaders(), "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)), Connection: "close",
  };
  // End gracefully so the generic response is delivered, but bound a peer
  // that never finishes its side of the connection. No request bytes/logs
  // are reflected, including parser error.rawPacket and error.message.
  const timeout = setTimeout(() => socket.destroy(), 5_000);
  timeout.unref();
  socket.once("close", () => clearTimeout(timeout));
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${body}`);
}

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
  if (!requestPath(req.url).startsWith("/api/")) return;
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
