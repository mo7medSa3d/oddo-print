import { IncomingMessage, type ServerResponse } from "http";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { parseStrictContentLength } from "../lib/request-limits";
import { runtimeSecret } from "../lib/runtime-secret";

/**
 * API body limit. The custom Next server must never consume the IncomingMessage
 * stream before Next has converted it to a Web Request. In production Caddy
 * also enforces this same 8 MiB ceiling at the edge.
 */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_AUTHENTICATED_CONCURRENT_BYTES = 32 * 1024 * 1024;
export const MAX_UNAUTHENTICATED_CONCURRENT_BYTES = 8 * 1024 * 1024;
export const MAX_CONCURRENT_CHUNKED_BYTES = MAX_AUTHENTICATED_CONCURRENT_BYTES;

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const SESSION_COOKIE_RE = /(?:^|;\s*)(?:mgr_session|plt_session)=/;
let reservedAuthBytes = 0;
let reservedUnauthBytes = 0;

export interface ApiBodyGuardOptions {
  maxBytes?: number;
}

/**
 * Rejected requests are answered with JSON and then released without feeding
 * the abandoned body to Next. Destroying the request socket synchronously
 * right after `res.end()` resets the TCP connection while the rejection
 * response may still be in flight, so well-behaved keep-alive clients observe
 * ECONNRESET instead of the documented 4xx/503 status. Instead we drain the
 * abandoned request body up to a bounded budget (lingering close, the same
 * trade-off Go's net/http `maxPostHandlerReadBytes` and nginx's
 * `lingering_close` make). The socket is torn down only on bounded-drain
 * overflow, request error, or timeout; destroying it on normal request `end`
 * or `close` can race the rejection response and turn a documented 413/411/403
 * into an ECONNRESET on Windows clients.
 */
const REJECT_DRAIN_MAX_BYTES = 16 * 1024 * 1024;
const REJECT_DRAIN_TIMEOUT_MS = 5_000;

function rejectRequest(req: IncomingMessage, res: ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");

  const payload = JSON.stringify({ success: false, error: code });
  let finalized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drained = 0;

  const finishResponse = () => {
    if (finalized) return;
    finalized = true;
    if (timer) clearTimeout(timer);
    if (!res.writableEnded) res.end();
  };

  const teardownAfterResponse = () => {
    if (!res.writableEnded && !res.headersSent) return;
    // Only tear down after Node has finished handing the rejection response to
    // the socket. Destroying the IncomingMessage before that point can race
    // the response on Windows and surface ECONNRESET instead of the 4xx.
    if (!req.destroyed) req.destroy();
  };

  res.writeHead(status);
  // Flush the status line/headers immediately. The response body remains
  // buffered until the bounded request drain finishes, allowing the client to
  // observe the rejection even while it is still uploading.
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(payload);

  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained >= REJECT_DRAIN_MAX_BYTES) {
      res.once("finish", teardownAfterResponse);
      finishResponse();
    }
  });
  req.once("end", finishResponse);
  req.once("error", () => {
    finishResponse();
  });

  timer = setTimeout(() => {
    res.once("finish", teardownAfterResponse);
    finishResponse();
  }, REJECT_DRAIN_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
}
function verifyJwtQuick(token: string): boolean {
  if (typeof token !== "string" || token.length < 40 || token.length > 4096) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  let secret: string | undefined;
  try {
    secret = runtimeSecret("GATEWAY_JWT_SECRET");
  } catch {
    // Admission classification must fail closed if the secret file is
    // unavailable or unreadable. Route-level authentication will surface the
    // actual configuration problem separately.
    return false;
  }
  // Resource-budget classification must fail closed. Route-level authentication
  // still decides access, but an unsigned JWT-shaped value must not let an
  // attacker reserve from the larger authenticated request pool.
  if (!secret || secret.length < 32) return false;
  try {
    const data = `${h}.${p}`;
    const expected = createHmac("sha256", secret).update(data).digest("base64url");
    const digestA = createHash("sha256").update(s, "utf8").digest();
    const digestB = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(digestA, digestB);
  } catch {
    return false;
  }
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
}

export function isCookieAuthenticatedMutation(req: IncomingMessage): boolean {
  return SESSION_COOKIE_RE.test(headerValue(req, "cookie"));
}

/**
 * Browser session mutations must prove same-origin at the HTTP boundary.
 * Authorization-header agent/Odoo traffic is intentionally excluded: it does
 * not rely on ambient browser cookies and must remain usable from native
 * clients.
 */
export function isCookieMutationSameOrigin(req: IncomingMessage): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (!MUTATING_METHODS.includes(method)) return true;
  if (!isCookieAuthenticatedMutation(req)) return true;

  const fetchSite = headerValue(req, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site") return false;

  const host = headerValue(req, "host").toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 255 || host.includes("/") || host.includes("@")) return false;

  const origin = headerValue(req, "origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      return parsed.host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  const referer = headerValue(req, "referer");
  if (referer) {
    try {
      const parsed = new URL(referer);
      return parsed.host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  // A browser carrying ambient cookies without the modern fetch-metadata or
  // standard origin signals is ambiguous; fail closed rather than treating
  // SameSite as the sole CSRF boundary.
  return fetchSite === "same-origin";
}

export function isLikelyAuthenticated(req: IncomingMessage): boolean {
  const headers = req.headers;
  const auth = headers["authorization"];
  const authHeader = typeof auth === "string" ? auth : Array.isArray(auth) ? auth[0] : "";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    // Only locally verifiable signed sessions receive the larger pool. Odoo API
    // keys and agent credentials are opaque DB-backed values; their prefix or
    // shape proves nothing at this pre-routing boundary.
    if (verifyJwtQuick(token)) return true;
  }

  const cookie = headers["cookie"];
  const cookieHeader = typeof cookie === "string" ? cookie : Array.isArray(cookie) ? cookie[0] : "";
  if (cookieHeader) {
    const match = /(?:mgr_session|plt_session)=([^;]+)/.exec(cookieHeader);
    if (match && match[1] && verifyJwtQuick(match[1].trim())) {
      return true;
    }
  }

  return false;
}

function reserve(bytes: number, authenticated: boolean): boolean {
  if (bytes < 0 || !Number.isSafeInteger(bytes)) return false;
  if (authenticated) {
    if (reservedAuthBytes + bytes > MAX_AUTHENTICATED_CONCURRENT_BYTES) return false;
    reservedAuthBytes += bytes;
  } else {
    if (reservedUnauthBytes + bytes > MAX_UNAUTHENTICATED_CONCURRENT_BYTES) return false;
    reservedUnauthBytes += bytes;
  }
  return true;
}

function release(bytes: number, authenticated: boolean): void {
  if (authenticated) {
    reservedAuthBytes = Math.max(0, reservedAuthBytes - bytes);
  } else {
    reservedUnauthBytes = Math.max(0, reservedUnauthBytes - bytes);
  }
}

/**
 * Release a previous reservation against the concurrent chunked budget.
 * Idempotency is enforced by the caller via `releaseOnce`; this export
 * exists so the reservation lifecycle is explicit and greppable, and so
 * tests/edge proxies can reconcile the budget.
 */
export function releaseChunkedBody(bytes: number, authenticated = true): void {
  release(bytes, authenticated);
}

export function getReservedRequestBytes(): number {
  return reservedAuthBytes + reservedUnauthBytes;
}

export function getReservedAuthBytes(): number {
  return reservedAuthBytes;
}

export function getReservedUnauthBytes(): number {
  return reservedUnauthBytes;
}

/** Payload-bearing endpoints whose bodies reserve the concurrency budget. */
function isPayloadBearingEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("/api/agent/") || url.startsWith("/api/print/");
}

/**
 * Admission-only request guard. It validates Content-Length and reserves the
 * maximum admitted bytes without touching the request stream. Chunked requests
 * are rejected with 411 because enforcing a hard byte ceiling without consuming
 * or replacing the stream would require the exact clone/lock workaround that
 * previously broke Next.js 16. Edge proxies should enforce Content-Length/body
 * limits before forwarding.
 *
 * Pre-auth DoS hardening:
 * - Authentication headers are pre-validated in memory before reserving against
 *   the 32 MiB authenticated concurrency budget.
 * - Requests that are unauthenticated or possess unverifiable credentials are
 *   restricted to the smaller 8 MiB unauthenticated budget pool.
 * - Chunked/missing-length mutating requests are rejected with 411 before
 *   Next sees the stream, so every JSON body has an enforceable byte ceiling.
 * - Reservation applies ONLY to payload-bearing endpoints; other /api/*
 *   routes are size-checked but never charge the concurrency budget.
 * - Every reservation remains held through route processing and is released
 *   exactly once when the response finishes or closes.
 */
export async function guardApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiBodyGuardOptions = {},
): Promise<IncomingMessage | null> {
  const maxBytes = options.maxBytes ?? MAX_API_BODY_BYTES;
  if (!req.url?.startsWith("/api/")) return req;
  if (!MUTATING_METHODS.includes(req.method ?? "")) return req;

  const payloadBearing = isPayloadBearingEndpoint(req.url);
  const authenticated = isLikelyAuthenticated(req);

  if (!isCookieMutationSameOrigin(req)) {
    rejectRequest(req, res, 403, "CSRF_VALIDATION_FAILED");
    return null;
  }

  const rawLength = req.headers["content-length"];
  const transferEncoding = req.headers["transfer-encoding"];

  if (rawLength === undefined) {
    // No Content-Length and no Transfer-Encoding means there is no declared
    // request body. Allow bodyless mutating requests such as DELETE /...?id=...
    // to reach their route handler.
    if (transferEncoding === undefined) return req;

    // Chunked requests cannot be hard-capped without consuming the stream,
    // which previously allowed non-payload mutating endpoints (login, billing,
    // settings, etc.) to hand an unbounded stream to Next's JSON parser. The
    // safe contract is therefore: every mutating API request carrying a
    // transfer-encoded body must declare Content-Length. Bodyless mutating
    // requests with neither header remain valid.
    rejectRequest(req, res, 411, "CONTENT_LENGTH_REQUIRED");
    return null;
  }

  const length = parseStrictContentLength(rawLength);
  if (length === null || length > maxBytes) {
    rejectRequest(req, res, 413, "REQUEST_BODY_TOO_LARGE");
    return null;
  }

  // Non-payload endpoints are size-checked only; they never reserve the
  // shared concurrency budget.
  if (!payloadBearing) return req;

  if (!reserve(length, authenticated)) {
    rejectRequest(req, res, 503, "REQUEST_BODY_CAPACITY_EXCEEDED");
    return null;
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseChunkedBody(length, authenticated);
  };
  res.once("finish", releaseOnce);
  res.once("close", releaseOnce);
  return req;
}
