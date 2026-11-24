/**
 * Opaque replay identities must never be silently normalized. Trimming a
 * malformed incoming key could reveal or reuse someone else's accepted job
 * instead of rejecting the invalid caller identity.
 */
// Keep rejected, already-typed string values alive for diagnostic errors.
// Only unknown input needs narrowing to a string after successful validation.
export function isExactIdempotencyKey(value: string): boolean;
export function isExactIdempotencyKey(value: unknown): value is string;
export function isExactIdempotencyKey(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 200
      || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try {
    // PostgreSQL and UTF-8 transports replace unpaired UTF-16 surrogates.
    // Never accept a different wire key than the caller presented: it could
    // collide with a prior print operation and silently replay its receipt.
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
