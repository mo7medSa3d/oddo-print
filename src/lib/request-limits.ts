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
  // Complete decimal integers only: parseInt("10junk") must not turn a
  // malformed query value into a valid pagination limit.
  const parsed = typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  const value = Number.isSafeInteger(parsed) ? parsed : fallback;
  return Math.min(Math.max(1, value), max);
}


/**
 * Read list offsets exactly, rather than accepting parseInt("10junk") or
 * silently treating invalid pagination as the first page.
 */
export function parseStrictListOffset(raw: string | null | undefined, max: number): number | null {
  if (raw == null) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= max ? value : null;
}

/**
 * An audit limit must be an exact safe positive decimal. Unlike general
 * list controls, malformed input is an HTTP 400 rather than a silent fallback.
 * Values beyond max retain the historical bounded page behavior.
 */
export function parseStrictListLimit(raw: string | null | undefined, fallback: number, max: number): number | null {
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, max) : null;
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
