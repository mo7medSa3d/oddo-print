import { readFileSync } from "node:fs";

// File-backed secrets (Docker /run/secrets) are read once and memoized for
// SECRET_CACHE_TTL_MS so every authenticated request does not pay a blocking
// filesystem read on the event loop. Rotation is picked up after the TTL
// (30s) or immediately when the *_FILE path itself changes.
const SECRET_CACHE_TTL_MS = 30_000;
type SecretCacheEntry = { file: string; value: string | undefined; expiresAt: number };
const secretCache = new Map<string, SecretCacheEntry>();

export function __clearSecretCacheForTests(): void {
  secretCache.clear();
}

/**
 * Resolve a runtime secret from an explicit *_FILE path first, then fall back
 * to the environment value for local development. Docker/Compose production
 * deployments should mount secrets as files under /run/secrets.
 */
export function runtimeSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    const now = Date.now();
    const cached = secretCache.get(name);
    if (cached && cached.file === file && cached.expiresAt > now) {
      return cached.value;
    }
    let value: string | undefined;
    try {
      value = readFileSync(file, "utf8").trim() || undefined;
    } catch {
      // A fresh cached value was already returned above. After its TTL,
      // an unreadable secret must fail closed rather than retain rotated
      // authority indefinitely. Keep the expired entry only for read retry.
      return undefined;
    }
    secretCache.set(name, { file, value, expiresAt: now + SECRET_CACHE_TTL_MS });
    return value;
  }
  secretCache.delete(name);
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

export function requiredRuntimeSecret(name: string): string {
  const value = runtimeSecret(name);
  if (!value) throw new Error(`${name} must be provided via ${name}_FILE or ${name}`);
  return value;
}
