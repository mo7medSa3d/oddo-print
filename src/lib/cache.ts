/**
 * Cache-Control for public content that is identical for every caller, such
 * as the public billing plan catalog: fresh for 30s, stale while revalidating
 * for 5 minutes. Session/tenant-dependent responses retain the server's
 * no-store default. Keep the existing constant name for its route consumer.
 */
export const PUBLIC_VARY_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=300, s-maxage=30";
