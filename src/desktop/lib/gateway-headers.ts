/** Only bounded nonsecret continuation metadata crosses the desktop bridge. */
export const GATEWAY_PAGINATION_HEADERS = [
  "x-has-more", "x-next-before-created-at", "x-next-before-id-encoded",
  "x-next-before-id", "x-next-cursor",
] as const;
export const GATEWAY_PAGINATION_HEADER_VALUE_MAX_BYTES = 4096;

export function readGatewayPaginationHeaders(lookup: (key: string) => unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of GATEWAY_PAGINATION_HEADERS) {
    const value = lookup(key);
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.length > GATEWAY_PAGINATION_HEADER_VALUE_MAX_BYTES
      || new TextEncoder().encode(value).length > GATEWAY_PAGINATION_HEADER_VALUE_MAX_BYTES) {
      // Losing or truncating a cursor could silently stop or repeat a page.
      throw new Error("Invalid Gateway pagination metadata");
    }
    headers[key] = value;
  }
  return headers;
}
