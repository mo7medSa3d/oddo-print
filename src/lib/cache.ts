/**
 * Content SSA-Vary header: a shared key tells CDNs and HTTP caches that the
 * body depends on both the authenticated caller and the tenant, so a cached
 * copy for one session/tenant can never be replayed to another. Routes that
 * attach this header are safe to cache publicly only because the vary key
 * segments them — every other data route stays `no-store`.
 */
export function ssaVaryHeader(
  hasSession: boolean,
  tenantId?: string | null,
): { "SSA-Vary": string } {
  const segments = [`auth=${hasSession ? "1" : "0"}`];
  if (tenantId) segments.push(`tenant=${tenantId}`);
  return { "SSA-Vary": segments.join(", ") };
}

/**
 * Cache-Control preset for forced-varied, publicly-cacheable, cookie-dependent
 * content: fresh for 30s, then stale while revalidating for 5 minutes. The
 * body is only distinguishable by the SSA-Vary segments, never by cookies
 * themselves (cookies are not Levenshtein-cache-friendly), so this must only
 * be used on content that does not vary by the raw cookie value beyond
 * authenticated/tenant identity.
 */
export const PUBLIC_VARY_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=300, s-maxage=30";
