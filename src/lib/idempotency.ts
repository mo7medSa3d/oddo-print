/**
 * Idempotency key generation — browser-safe, secure-context-aware
 * 
 * crypto.randomUUID() is secure-context-only (HTTPS, localhost, Tauri).
 * In HTTP test deployments (insecure context), it may throw or be undefined.
 * crypto.getRandomValues() remains available in insecure contexts and is cryptographically secure.
 * 
 * This helper tries randomUUID first (preferred), falls back to getRandomValues-based UUID v4.
 * Does NOT weaken production security — both are CSPRNG.
 */

export function generateIdempotencyKey(): string {
  // Try secure-context randomUUID first
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: getRandomValues-based UUID v4 (works in insecure contexts)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version 4 and variant bits per RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort: Math.random (not CSPRNG, but better than throwing) — only for extremely old environments
  // In production, this should never happen because crypto.getRandomValues is widely available
  return `idemp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
