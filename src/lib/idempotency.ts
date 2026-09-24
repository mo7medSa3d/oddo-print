/**
 * Idempotency key generation — browser-safe, secure-context-aware, CSPRNG-only
 *
 * crypto.randomUUID() is secure-context-only (HTTPS, localhost, Tauri) per MDN.
 * In HTTP test deployments (insecure context), it may throw or be undefined.
 * crypto.getRandomValues() is the Crypto member that remains available in
 * insecure contexts and is cryptographically strong (CSPRNG).
 *
 * This helper tries randomUUID first (preferred, CSPRNG), falls back to
 * getRandomValues-based UUID v4 (CSPRNG, works in insecure contexts).
 * If neither is available, it throws explicitly — no Math.random() fallback.
 *
 * Rationale per review: even though idempotency keys are not credentials,
 * they require reliable uniqueness/entropy. Using Math.random() would produce
 * weaker keys in an unsupported environment; explicit failure is preferable
 * to silent entropy degradation. Production security is not weakened — both
 * paths are CSPRNG.
 */

export function generateIdempotencyKey(): string {
  // Try secure-context randomUUID first (CSPRNG)
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to getRandomValues fallback
  }

  // Fallback: getRandomValues-based UUID v4 (CSPRNG, works in insecure contexts per MDN)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version 4 and variant bits per RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // No Math.random() fallback — fail explicitly in unsupported environments
  throw new Error(
    "Secure random generator unavailable: crypto.randomUUID() and crypto.getRandomValues() are both unavailable. Idempotency key requires CSPRNG."
  );
}
