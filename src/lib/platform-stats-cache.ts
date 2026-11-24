interface CachedPlatformStats {
  data: Record<string, unknown>;
  cachedAt: number;
}

let platformStatsCache: CachedPlatformStats | null = null;
const STATS_CACHE_TTL_MS = 5_000;

export function getCachedPlatformStats(bypassCache = false): Record<string, unknown> | null {
  if (bypassCache) return null;
  if (process.env.NODE_ENV === "test") return null;
  if (!platformStatsCache) return null;
  if (Date.now() - platformStatsCache.cachedAt >= STATS_CACHE_TTL_MS) {
    platformStatsCache = null;
    return null;
  }
  return platformStatsCache.data;
}

export function setCachedPlatformStats(data: Record<string, unknown>): void {
  platformStatsCache = {
    data,
    cachedAt: Date.now(),
  };
}

export function clearPlatformStatsCache(): void {
  platformStatsCache = null;
}
