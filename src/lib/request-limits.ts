/** Parse one HTTP Content-Length value as a safe, unsigned decimal integer. */
export function parseStrictContentLength(raw: string | string[]): number | null {
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Clamp a `?limit=` query value to `1..max`, falling back when missing or
 * unparsable. A negative or zero limit must never reach Drizzle `.limit()`
 * (Postgres rejects `LIMIT -5` with a 500); previously three list routes
 * clamped only the ceiling.
 */
export function clampListLimit(raw: string | null | undefined, fallback: number, max: number): number {
  const parsed = parseInt(raw ?? "", 10);
  const value = Number.isNaN(parsed) ? fallback : parsed;
  return Math.min(Math.max(1, value), max);
}

/**
 * Checks the declared HTTP Content-Length before a JSON body is parsed.
 * The custom HTTP server also enforces a global ceiling for chunked requests;
 * a reverse proxy should enforce an equivalent limit when it terminates or
 * forwards traffic before the application server.
 */
export function hasBodyOverLimit(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get("content-length");
  if (!raw) return false;

  const length = parseStrictContentLength(raw);
  return length === null || length > maxBytes;
}
