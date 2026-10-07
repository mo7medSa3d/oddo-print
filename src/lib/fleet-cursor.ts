/** Decode an optional ID without lossy HTTP header or UTF-8 conversions. */
export function readFleetCursorId(params: URLSearchParams): string | null {
  const raw = params.get("beforeId");
  const encoded = params.get("beforeIdEncoded");
  let id = raw;
  if (encoded !== null) {
    if (!/^[A-Za-z0-9_-]{1,2732}$/.test(encoded)) throw new Error("Invalid encoded fleet cursor ID");
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error("Invalid encoded fleet cursor ID");
    if (raw !== null && raw !== decoded) throw new Error("Conflicting fleet cursor IDs");
    id = decoded;
  }
  if (id !== null && (id.length < 1 || id.length > 512)) throw new Error("beforeId must be between 1 and 512 characters");
  return id;
}

/** Preserve legacy ASCII headers; always offer a canonical UTF-8 cursor. */
export function fleetCursorIdHeaders(id: string): Record<string, string> {
  return {
    "X-Next-Before-Id-Encoded": Buffer.from(id, "utf8").toString("base64url"),
    ...(/^[\x21-\x7e]+$/.test(id) ? { "X-Next-Before-Id": id } : {}),
  };
}
