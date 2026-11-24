import { readFileSync, statSync } from "node:fs";

// File-backed secrets (Docker /run/secrets) are read once and memoized so
// every authenticated request does not pay a blocking filesystem read on the
// event loop. The cache is invalidated by the file's identity (mtime + size)
// rather than by a timer alone, so a rotated secret takes effect on the next
// request instead of after the TTL. The TTL remains as a backstop for a
// rotation that preserves mtime and size.
const SECRET_CACHE_TTL_MS = 30_000;
type SecretCacheEntry = {
  file: string;
  value: string | undefined;
  expiresAt: number;
  mtimeMs: number;
  size: number;
};
const secretCache = new Map<string, SecretCacheEntry>();

export function __clearSecretCacheForTests(): void {
  secretCache.clear();
}

function fileIdentity(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
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
    const identity = fileIdentity(file);
    if (cached && cached.file === file && cached.expiresAt > now) {
      // A cached value is reusable while the file is unchanged. Comparing
      // mtime and size detects a rotated secret immediately, so a revoked
      // credential stops being accepted on the next request instead of after
      // the TTL. When the file is momentarily unreadable (a secret mount
      // being swapped) the fresh cached value is still served, and the
      // fail-closed behaviour still applies once the TTL elapses.
      if (!identity || (identity.mtimeMs === cached.mtimeMs && identity.size === cached.size)) {
        return cached.value;
      }
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
    secretCache.set(name, {
      file,
      value,
      expiresAt: now + SECRET_CACHE_TTL_MS,
      mtimeMs: identity?.mtimeMs ?? 0,
      size: identity?.size ?? 0,
    });
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
