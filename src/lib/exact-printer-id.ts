/**
 * Printer IDs are opaque execution identities, never display labels.
 * Neither a request, heartbeat, nor a private-sharing notification may trim
 * or otherwise coerce one ID into another printer's authority.
 *
 * The Gateway inventory and native Agent wire contract cap IDs at 120 UTF-8
 * bytes. Keep this dependency-free for both API validation and service calls.
 */
// A call with an already-typed string is a value VALIDATION, not a type
// narrowing: the rejected string must remain available for error reporting.
// Unknown inputs retain the type guard for callers that parse untrusted JSON.
export function isExactPrinterId(value: string): boolean;
export function isExactPrinterId(value: unknown): value is string;
export function isExactPrinterId(value: unknown): boolean {
  if (typeof value !== "string" || !value || value !== value.trim()
      || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try {
    // A lone UTF-16 surrogate is not a valid UTF-8 identity. TextEncoder
    // would silently replace it; fail closed before that target changes.
    encodeURIComponent(value);
    return new TextEncoder().encode(value).byteLength <= 120;
  } catch {
    return false;
  }
}
